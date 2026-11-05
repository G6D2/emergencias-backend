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

class OutboxPublisher {
  constructor(pool, kafkaService, options = {}) {
    this.pool = pool;
    this.kafkaService = kafkaService;
    // Feature flag EDA_PUBLISHER_MODE=gateway (issue #74): index.js inyecta un
    // GatewayPublisher como options.publisher. Default = KafkaService (sin
    // cambios respecto al comportamiento previo al PR del gateway publisher).
    this.publisher = options.publisher || kafkaService;
    this.batchSize = options.batchSize || 50;
    this.intervalMs = options.intervalMs || 5000;
    this.maxAttempts = options.maxAttempts || Number(process.env.OUTBOX_MAX_ATTEMPTS || 10);
    this.maxBackoffMs = options.maxBackoffMs || Number(process.env.OUTBOX_MAX_BACKOFF_MS || 15 * 60 * 1000);
    this.publishedRetentionMs = options.publishedRetentionMs
      || Number(process.env.OUTBOX_PUBLISHED_RETENTION_HOURS || 168) * 60 * 60 * 1000;
    // Issue #71: piso temporal al activar el bus. PENDING creados antes de
    // esta marca se descartan como SKIPPED en skipPendingBefore() y nunca
    // se reclaman (filtro defensivo en claimBatch por si el saneo no corrio).
    this.publishSince = resolvePublishSince(
      options.publishSince !== undefined ? options.publishSince : process.env.OUTBOX_PUBLISH_SINCE
    );
    this.timer = null;
    this.running = false;
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

  async claimBatch() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Issue #71: el filtro de publishSince solo aplica a PENDING. Los
      // PROCESSING-huerfanos (lock vencido > 1min) se siguen liberando
      // porque son errores operativos ortogonales a la activacion del bus.
      const since = this.publishSince ? this.publishSince.toISOString() : null;
      const result = await client.query(
        `UPDATE outbox_events
         SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM outbox_events
           WHERE (
             status = 'PENDING'
             AND available_at <= now()
             AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
           ) OR (
             status = 'PROCESSING' AND locked_at < now() - interval '1 minute'
           )
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         RETURNING id, topic, payload, attempts`,
        [this.batchSize, since]
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

  async markPublished(id, result = null) {
    // result opcional: GatewayPublisher devuelve { eventId, payloadHash } del
    // response 2xx del gateway. KafkaService devuelve true/false — no hay
    // eventId ni payloadHash y los campos quedan NULL (comportamiento previo).
    // Las columnas payload_hash y gateway_event_id vienen de la migracion V24.
    const payloadHash = result && result.payloadHash ? result.payloadHash : null;
    const gatewayEventId = result && result.eventId ? result.eventId : null;
    await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED', published_at = now(), locked_at = NULL, last_error = NULL,
           payload_hash = COALESCE($2, payload_hash),
           gateway_event_id = COALESCE($3::uuid, gateway_event_id)
       WHERE id = $1`,
      [id, payloadHash, gatewayEventId]
    );
  }

  async markFailed(id, attempts, error) {
    // Clasificacion de errores del GatewayPublisher (issue #74):
    //   - error.isPermanent (400/404/413/401-tras-reintento): no reintentar, FAILED directo.
    //   - error.retryAfterMs (429 Retry-After): respetar el backoff del gateway.
    //   - resto: backoff exponencial propio.
    const permanent = Boolean(error && error.isPermanent);
    const failed = permanent || attempts >= this.maxAttempts;
    let backoffMs;
    if (failed) {
      backoffMs = 0;
    } else if (error && Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
      backoffMs = Math.min(error.retryAfterMs, this.maxBackoffMs);
    } else {
      backoffMs = Math.min(30_000 * (2 ** Math.max(attempts - 1, 0)), this.maxBackoffMs);
    }
    await this.pool.query(
      `UPDATE outbox_events
       SET status = $2, available_at = now() + ($3::double precision * interval '1 millisecond'),
           locked_at = NULL, last_error = $4
       WHERE id = $1`,
      [id, failed ? 'FAILED' : 'PENDING', backoffMs, String(error.message || error).slice(0, 2000)]
    );
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
    this.running = true;
    let published = 0;
    try {
      if (this.publisher.isEnabled()) {
        const events = await this.claimBatch();
        for (const event of events) {
          try {
            const sent = await this.publisher.publishEvent(event.topic, event.payload);
            if (!sent) throw new Error('Publisher disabled or not connected');
            // GatewayPublisher devuelve objeto { eventId, payloadHash };
            // KafkaService devuelve true. markPublished tolera ambos.
            const result = typeof sent === 'object' ? sent : null;
            await this.markPublished(event.id, result);
            published += 1;
          } catch (error) {
            await this.markFailed(event.id, event.attempts, error);
            secureLog('warn', 'Outbox event delivery failed', {
              ...summarizeEventForLog(event.topic, event.payload),
              message: error.message,
            });
          }
        }
      }
      await this.purgePublished();
      return published;
    } finally {
      this.running = false;
    }
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
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// OUTBOX_PUBLISHER_ENABLED=false deja Kafka prendido solo para consumir. Hasta
// que el outbox publique por el gateway (#69), escribir directo en el bus
// mandaría JSON con los tópicos viejos a tópicos que otros grupos leen en Avro.
function isOutboxPublisherEnabled(env = process.env) {
  return env.OUTBOX_PUBLISHER_ENABLED !== 'false';
}

module.exports = { OutboxPublisher, resolvePublishSince, isOutboxPublisherEnabled };