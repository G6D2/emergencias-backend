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
    // La purga de PUBLISHED viejos no necesita correr en cada poll.
    this.purgeIntervalMs = options.purgeIntervalMs || 60 * 60 * 1000;
    this.timer = null;
    this.purgeTimer = null;
    this.running = false;
    this.lastPollAt = null;
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

  async markPublished(id) {
    await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED', published_at = now(), locked_at = NULL, last_error = NULL
       WHERE id = $1`,
      [id]
    );
  }

  async markFailed(id, attempts, error) {
    const failed = attempts >= this.maxAttempts;
    const backoffMs = Math.min(30_000 * (2 ** Math.max(attempts - 1, 0)), this.maxBackoffMs);
    await this.pool.query(
      `UPDATE outbox_events
       SET status = $2, available_at = now() + ($3::double precision * interval '1 millisecond'),
           locked_at = NULL, last_error = $4
       WHERE id = $1`,
      [id, failed ? 'FAILED' : 'PENDING', failed ? 0 : backoffMs, String(error.message || error).slice(0, 2000)]
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
    // Sin Kafka no hay nada que publicar: sale sin tocar la base (cada query
    // mantiene despierto el compute de Neon) ni gastar intentos de los eventos.
    if (!this.kafkaService.isEnabled()) return 0;
    this.running = true;
    let published = 0;
    try {
      // El producer se conecta acá y no al arrancar el proceso: con el
      // publisher apagado no queda una conexión ociosa al bus. Si se cae (un
      // send fallido lo marca desconectado), se reintenta en el próximo poll.
      if (!this.kafkaService.isConnected() && !(await this.kafkaService.connect())) {
        return 0;
      }
      const events = await this.claimBatch();
      this.lastPollAt = new Date();
      for (const event of events) {
        try {
          const sent = await this.kafkaService.publishEvent(event.topic, event.payload);
          if (!sent) throw new Error('Kafka disabled or not connected');
          await this.markPublished(event.id);
          published += 1;
        } catch (error) {
          await this.markFailed(event.id, event.attempts, error);
          secureLog('warn', 'Outbox event delivery failed', {
            ...summarizeEventForLog(event.topic, event.payload),
            message: error.message,
          });
        }
      }
      return published;
    } finally {
      this.running = false;
    }
  }

  purgeExpired() {
    return this.purgePublished()
      .catch((error) => secureLog('error', 'Outbox purge failed', { message: error.message }));
  }

  // Estado en memoria para /health (no consulta la base).
  health() {
    return {
      enabled: this.timer !== null,
      lastPollAt: this.lastPollAt ? this.lastPollAt.toISOString() : null,
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

module.exports = { OutboxPublisher, resolvePublishSince, isOutboxPublisherEnabled };