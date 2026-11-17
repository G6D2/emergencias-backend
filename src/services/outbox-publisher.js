const { secureLog, summarizeEventForLog } = require('../security/secure-log');

function resolvePublishSince(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      throw new Error('OUTBOX_PUBLISH_SINCE invalido: Date no parseable');
    }
    return raw;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`OUTBOX_PUBLISH_SINCE invalido: "${raw}" no es ISO 8601`);
  }
  return parsed;
}

// Entero positivo de una variable de entorno; si falta o no sirve, el default.
function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Emergencia a la que pertenece un evento del outbox. EmergenciaCreada,
// EmergenciaActualizada y EmergenciaVinculadaAContextoZona la traen en
// data.emergenciaId; EmergenciaPriorizada, en data.id. Sin ninguna de las dos
// (NULL) el evento no espera a nadie.
const EMERGENCY_KEY_SQL = (alias) => `COALESCE(${alias}.payload->'data'->>'emergenciaId', ${alias}.payload->'data'->>'id')`;

// Pausa del publisher después de un error transitorio: arranca en un intervalo
// de poll y se duplica con cada fallo seguido, hasta este tope. Un 429 con
// Retry-After usa ese valor.
const MAX_PAUSE_MS = 5 * 60 * 1000;

class OutboxPublisher {
  constructor(pool, kafkaService, options = {}) {
    this.pool = pool;
    this.kafkaService = kafkaService;
    // Feature flag EDA_PUBLISHER_MODE=gateway (issue #74): index.js inyecta un
    // GatewayPublisher como options.publisher. Default = KafkaService (sin
    // cambios respecto al comportamiento previo al PR del gateway publisher).
    this.publisher = options.publisher || kafkaService;
    // Issue #104: configurables para frenar el vaciado después de una caída
    // larga si el Grupo 1 lo pide. Son eventos por corrida y ms entre corridas.
    this.batchSize = options.batchSize || positiveInteger(process.env.OUTBOX_BATCH_SIZE, 50);
    this.intervalMs = options.intervalMs || positiveInteger(process.env.OUTBOX_POLL_INTERVAL_MS, 5000);
    this.maxBackoffMs = options.maxBackoffMs || Number(process.env.OUTBOX_MAX_BACKOFF_MS || 15 * 60 * 1000);
    this.maxPauseMs = options.maxPauseMs || Math.min(MAX_PAUSE_MS, this.maxBackoffMs);
    this.publishedRetentionMs = options.publishedRetentionMs
      || Number(process.env.OUTBOX_PUBLISHED_RETENTION_HOURS || 168) * 60 * 60 * 1000;
    // Issue #71: piso temporal al activar el bus. PENDING creados antes de
    // esta marca se descartan como SKIPPED en skipPendingBefore() y nunca
    // se reclaman (filtro defensivo en claimBatch por si el saneo no corrio).
    this.publishSince = resolvePublishSince(
      options.publishSince !== undefined ? options.publishSince : process.env.OUTBOX_PUBLISH_SINCE
    );
    // La purga de PUBLISHED viejos no necesita correr en cada poll.
    this.purgeIntervalMs = options.purgeIntervalMs || 60 * 60 * 1000;
    this.timer = null;
    this.purgeTimer = null;
    this.running = false;
    this.lastPollAt = null;
    // Issue #104: pausa en memoria (por proceso) mientras el bus no responde.
    this.pausedUntil = null;
    this.consecutiveFailures = 0;
    this.now = options.now || Date.now;
  }

  async skipPendingBefore() {
    if (!this.publishSince) return 0;
    const result = await this.pool.query(
      `UPDATE outbox_events
       SET status = 'SKIPPED', locked_at = NULL
       WHERE status = 'PENDING' AND created_at < $1`,
      [this.publishSince.toISOString()]
    );
    return result.rowCount || 0;
  }

  async claimBatch(limit = this.batchSize) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Issue #71: el filtro de publishSince solo aplica a PENDING. Los
      // PROCESSING-huerfanos (lock vencido > 1min) se siguen liberando
      // porque son errores operativos ortogonales a la activacion del bus.
      const since = this.publishSince ? this.publishSince.toISOString() : null;
      // Orden por emergencia (issue #104): un evento no se reclama mientras
      // haya uno anterior de la misma emergencia sin terminar (PENDING,
      // PROCESSING o FAILED). PUBLISHED y SKIPPED no frenan, ni los PENDING
      // anteriores a publishSince (se descartan al arrancar). Así entra a lo
      // sumo un evento por emergencia por lote y un evento que falla deja
      // esperando a los posteriores de su emergencia, aunque su reintento
      // quede programado para después. También vale entre instancias: el
      // anterior sigue PENDING o PROCESSING hasta que alguien lo publica.
      //
      // El ORDER BY del subselect solo elige cuáles entran al lote: las filas
      // que devuelve UPDATE ... RETURNING no salen en ese orden. Como runOnce
      // publica el lote en el orden en que lo recibe, se ordena acá.
      const result = await client.query(
        `WITH claimed AS (
           UPDATE outbox_events
           SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
           WHERE id IN (
             SELECT o.id FROM outbox_events o
             WHERE (
               (
                 o.status = 'PENDING'
                 AND o.available_at <= now()
                 AND ($2::timestamptz IS NULL OR o.created_at >= $2::timestamptz)
               ) OR (
                 o.status = 'PROCESSING' AND o.locked_at < now() - interval '1 minute'
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM outbox_events prev
               WHERE prev.status IN ('PENDING', 'PROCESSING', 'FAILED')
                 AND NOT (prev.status = 'PENDING' AND $2::timestamptz IS NOT NULL AND prev.created_at < $2::timestamptz)
                 AND ${EMERGENCY_KEY_SQL('prev')} = ${EMERGENCY_KEY_SQL('o')}
                 AND (prev.created_at, prev.id) < (o.created_at, o.id)
             )
             ORDER BY o.created_at, o.id
             FOR UPDATE OF o SKIP LOCKED
             LIMIT $1
           )
           RETURNING id, topic, payload, attempts, created_at
         )
         SELECT id, topic, payload, attempts FROM claimed ORDER BY created_at, id`,
        [limit, since]
      );
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // markPublished, markSkipped y markFailed solo tocan la fila si sigue siendo
  // de este reclamo: status PROCESSING y el mismo attempts que devolvió
  // claimBatch. Cada reclamo incrementa attempts, así que si el lock venció
  // (> 1 min) y otro proceso la volvió a reclamar, attempts ya no coincide y
  // el UPDATE no hace nada. Sin esto, un proceso lento pisaba el PUBLISHED del
  // otro con PENDING y el evento salía dos veces al bus.
  // Devuelven true si actualizaron la fila.
  warnLostClaim(id, attempts, action) {
    secureLog('warn', 'Outbox: la fila ya no es de este reclamo, no se actualiza', {
      id, attempts, action,
    });
  }

  async markPublished(id, attempts, result = null) {
    // result opcional: GatewayPublisher devuelve { eventId, payloadHash } del
    // response 2xx del gateway. KafkaService devuelve true/false — no hay
    // eventId ni payloadHash y los campos quedan NULL (comportamiento previo).
    // Las columnas payload_hash y gateway_event_id vienen de la migracion V24.
    const payloadHash = result && result.payloadHash ? result.payloadHash : null;
    const gatewayEventId = result && result.eventId ? result.eventId : null;
    const { rowCount } = await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED', published_at = now(), locked_at = NULL, last_error = NULL,
           payload_hash = COALESCE($2, payload_hash),
           gateway_event_id = COALESCE($3::uuid, gateway_event_id)
       WHERE id = $1 AND status = 'PROCESSING' AND attempts = $4`,
      [id, payloadHash, gatewayEventId, attempts]
    );
    if (rowCount === 0) this.warnLostClaim(id, attempts, 'PUBLISHED');
    return rowCount > 0;
  }

  // Tipo que el publisher no saca al bus (EmergenciaPriorizada con el
  // gateway): queda SKIPPED y no se reintenta.
  async markSkipped(id, attempts) {
    const { rowCount } = await this.pool.query(
      `UPDATE outbox_events
       SET status = 'SKIPPED', locked_at = NULL, last_error = 'tipo fuera del contrato del bus'
       WHERE id = $1 AND status = 'PROCESSING' AND attempts = $2`,
      [id, attempts]
    );
    if (rowCount === 0) this.warnLostClaim(id, attempts, 'SKIPPED');
    return rowCount > 0;
  }

  async markFailed(id, attempts, error) {
    // Clasificacion de errores del GatewayPublisher (issue #74):
    //   - error.isPermanent (400/403/404/413/401-tras-reintento): no reintentar, FAILED directo.
    //   - error.retryAfterMs (429 Retry-After): respetar el backoff del gateway.
    //   - resto: backoff exponencial propio.
    // Issue #104: un error transitorio (red, timeout, 5xx, 429) nunca deja la
    // fila FAILED, por más intentos que lleve: se sigue reintentando con la
    // espera acotada a maxBackoffMs. Antes, a los 10 intentos (~75 min de
    // caída) quedaba FAILED y no salía nunca más.
    const failed = Boolean(error?.isPermanent);
    let backoffMs;
    if (failed) {
      backoffMs = 0;
    } else if (error && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
      backoffMs = Math.min(error.retryAfterMs, this.maxBackoffMs);
    } else {
      backoffMs = Math.min(30_000 * (2 ** Math.max(attempts - 1, 0)), this.maxBackoffMs);
    }
    const { rowCount } = await this.pool.query(
      `UPDATE outbox_events
       SET status = $2, available_at = now() + ($3::double precision * interval '1 millisecond'),
           locked_at = NULL, last_error = $4
       WHERE id = $1 AND status = 'PROCESSING' AND attempts = $5`,
      [id, failed ? 'FAILED' : 'PENDING', backoffMs, String(error.message || error).slice(0, 2000), attempts]
    );
    if (rowCount === 0) this.warnLostClaim(id, attempts, failed ? 'FAILED' : 'PENDING');
    return rowCount > 0;
  }

  // Devuelve a PENDING, sin demora, las filas reclamadas que no se llegaron a
  // mandar porque el lote se cortó. El reclamo había sumado un intento que no
  // se usó: se resta, así attempts sigue contando envíos reales (y el backoff
  // no crece por cortes). Misma guarda que mark*: solo si siguen siendo de
  // este reclamo.
  async releaseClaims(events) {
    if (events.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE outbox_events o
       SET status = 'PENDING', locked_at = NULL, attempts = o.attempts - 1
       FROM unnest($1::uuid[], $2::int[]) AS claim(id, attempts)
       WHERE o.id = claim.id AND o.status = 'PROCESSING' AND o.attempts = claim.attempts`,
      [events.map((event) => event.id), events.map((event) => event.attempts)]
    );
    return rowCount || 0;
  }

  isPaused() {
    return this.pausedUntil !== null && this.now() < this.pausedUntil;
  }

  // Error transitorio: el bus está caído o saturado. Nada se reclama hasta
  // que pase la pausa (Retry-After si vino, si no una espera que se duplica
  // con cada fallo seguido). La primera corrida después de la pausa prueba
  // con un solo envío: si vuelve a fallar, corta y pausa de nuevo.
  pause(error) {
    this.consecutiveFailures += 1;
    const retryAfterMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
      ? Math.min(error.retryAfterMs, this.maxBackoffMs)
      : null;
    const pauseMs = retryAfterMs
      ?? Math.min(this.intervalMs * (2 ** (this.consecutiveFailures - 1)), this.maxPauseMs);
    this.pausedUntil = this.now() + pauseMs;
    secureLog('warn', 'Outbox en pausa: el bus no responde', {
      pauseMs,
      consecutiveFailures: this.consecutiveFailures,
      message: error.message,
    });
  }

  resume() {
    if (this.consecutiveFailures > 0) {
      secureLog('info', 'Outbox: el bus volvió a responder', { consecutiveFailures: this.consecutiveFailures });
    }
    this.consecutiveFailures = 0;
    this.pausedUntil = null;
  }

  async purgePublished() {
    const result = await this.pool.query(
      `DELETE FROM outbox_events
       WHERE status = 'PUBLISHED'
         AND published_at < now() - ($1::double precision * interval '1 millisecond')`,
      [this.publishedRetentionMs]
    );
    return result.rowCount;
  }

  async runOnce() {
    if (this.running) return 0;
    // Sin publisher habilitado (KAFKA_ENABLED para KafkaService,
    // EDA_PUBLISHER_MODE=gateway para el GatewayPublisher) no hay nada que
    // publicar: sale sin tocar la base (cada query mantiene despierto el compute
    // de Neon) ni gastar intentos de los eventos.
    if (!this.publisher.isEnabled()) return 0;
    // En pausa (issue #104) no se reclama nada ni se toca la base.
    if (this.isPaused()) return 0;
    this.running = true;
    let published = 0;
    try {
      // El producer de Kafka se conecta acá y no al arrancar el proceso: con el
      // publisher apagado no queda una conexión ociosa al bus. Si se cae (un
      // send fallido lo marca desconectado), se reintenta en el próximo poll.
      // Con el GatewayPublisher (HTTP) no hay producer que conectar.
      if (this.publisher === this.kafkaService
        && !this.kafkaService.isConnected() && !(await this.kafkaService.connect())) {
        return 0;
      }
      // claimBatch trae a lo sumo un evento por emergencia: se vuelve a
      // reclamar mientras salgan eventos, hasta batchSize por corrida. Así los
      // eventos seguidos de una emergencia (alta + vínculos, varios cambios de
      // estado) salen en la misma corrida y en orden, sin superar el ritmo de
      // vaciado de siempre.
      let remaining = this.batchSize;
      while (remaining > 0) {
        const events = await this.claimBatch(remaining);
        this.lastPollAt = new Date();
        if (events.length === 0) break;
        remaining -= events.length;
        const batch = await this.publishClaimed(events);
        published += batch.published;
        if (batch.interrupted) break;
      }
      return published;
    } finally {
      this.running = false;
    }
  }

  // Publica un lote reclamado, en orden. Ante un error transitorio corta el
  // lote (issue #104): antes seguía con el resto, cada uno esperando su
  // timeout contra un bus caído y gastando un intento.
  async publishClaimed(events) {
    let published = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      let sent;
      try {
        sent = await this.publisher.publishEvent(event.topic, event.payload);
        if (!sent) throw new Error('Publisher disabled or not connected');
      } catch (error) {
        await this.markFailed(event.id, event.attempts, error);
        secureLog('warn', 'Outbox event delivery failed', {
          ...summarizeEventForLog(event.topic, event.payload),
          message: error.message,
        });
        // Un error propio del evento (400, 404...) no dice nada del bus: el
        // lote sigue.
        if (error.isPermanent) continue;
        await this.releaseClaims(events.slice(index + 1));
        this.pause(error);
        return { published, interrupted: true };
      }
      if (typeof sent === 'object' && sent.skipped) {
        // No pasó por el bus: no confirma que esté andando.
        await this.markSkipped(event.id, event.attempts);
        continue;
      }
      this.resume();
      // GatewayPublisher devuelve { eventId, payloadHash }; KafkaService
      // devuelve true. markPublished tolera ambos.
      const result = typeof sent === 'object' ? sent : null;
      await this.markPublished(event.id, event.attempts, result);
      published += 1;
    }
    return { published, interrupted: false };
  }

  purgeExpired() {
    return this.purgePublished()
      .catch((error) => secureLog('error', 'Outbox purge failed', { message: error.message }));
  }

  // Estado en memoria para /health (no consulta la base).
  health() {
    return {
      enabled: this.timer !== null,
      // 'kafka' publica con el producer; 'gateway' por HTTP (no usa producer).
      publisher: this.publisher === this.kafkaService ? 'kafka' : 'gateway',
      lastPollAt: this.lastPollAt ? this.lastPollAt.toISOString() : null,
      // Issue #104: hasta cuándo no se publica porque el bus no responde, y
      // cuántos errores transitorios seguidos lleva.
      pausedUntil: this.isPaused() ? new Date(this.pausedUntil).toISOString() : null,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  start() {
    // Issue #71: saneo one-shot al activar el bus. Idempotente: si no hay
    // publishSince o ya corrio antes, el UPDATE afecta 0 filas.
    this.skipPendingBefore()
      .then((skipped) => {
        if (skipped > 0) {
          secureLog('info', 'Outbox PENDING previos descartados al activar el bus', {
            skipped,
            since: this.publishSince.toISOString(),
          });
        }
      })
      .catch((error) => secureLog('error', 'Outbox skip-pending failed', { message: error.message }));
    this.runOnce().catch((error) => secureLog('error', 'Outbox poll failed', { message: error.message }));
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => secureLog('error', 'Outbox poll failed', { message: error.message }));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Purga al arrancar y después cada hora: Render free reinicia seguido,
    // así que la del arranque es la que más corre. purgeExpired no rechaza.
    void this.purgeExpired();
    this.purgeTimer = setInterval(() => this.purgeExpired(), this.purgeIntervalMs);
    if (typeof this.purgeTimer.unref === 'function') this.purgeTimer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.timer = null;
    this.purgeTimer = null;
  }
}

// Opt-in: publica solo con OUTBOX_PUBLISHER_ENABLED=true. Sin la variable, Kafka
// queda prendido solo para consumir. Hasta que el outbox publique por el
// gateway (#69), escribir directo en el bus mandaría JSON con los tópicos
// viejos a tópicos que otros grupos leen en Avro.
function isOutboxPublisherEnabled(env = process.env) {
  return env.OUTBOX_PUBLISHER_ENABLED === 'true';
}

module.exports = {
  OutboxPublisher, resolvePublishSince, isOutboxPublisherEnabled, EMERGENCY_KEY_SQL,
};