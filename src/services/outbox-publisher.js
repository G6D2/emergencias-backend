const { secureLog, summarizeEventForLog } = require('../security/secure-log');

class OutboxPublisher {
  constructor(pool, kafkaService, options = {}) {
    this.pool = pool;
    this.kafkaService = kafkaService;
    // Feature flag EDA_PUBLISHER_MODE=gateway (ADR #25): index.js inyecta un
    // GatewayPublisher como options.publisher. Default = KafkaService (sin
    // cambios respecto al comportamiento previo al PR del gateway publisher).
    this.publisher = options.publisher || kafkaService;
    this.batchSize = options.batchSize || 50;
    this.intervalMs = options.intervalMs || 5000;
    this.maxAttempts = options.maxAttempts || Number(process.env.OUTBOX_MAX_ATTEMPTS || 10);
    this.maxBackoffMs = options.maxBackoffMs || Number(process.env.OUTBOX_MAX_BACKOFF_MS || 15 * 60 * 1000);
    this.publishedRetentionMs = options.publishedRetentionMs
      || Number(process.env.OUTBOX_PUBLISHED_RETENTION_HOURS || 168) * 60 * 60 * 1000;
    this.timer = null;
    this.running = false;
  }

  async claimBatch() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE outbox_events
         SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM outbox_events
           WHERE (status = 'PENDING' AND available_at <= now())
              OR (status = 'PROCESSING' AND locked_at < now() - interval '1 minute')
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         RETURNING id, topic, payload, attempts`,
        [this.batchSize]
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
    // result opcional: GatewayPublisher devuelve { payloadHash, eventId }.
    // KafkaService devuelve true/false — no hay payloadHash y los campos
    // quedan NULL (comportamiento previo al PR del gateway publisher).
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
    // error.isPermanent (400/404/413 del gateway, FQN invalido): no reintentar.
    // error.retryAfterMs (429 Retry-After): respetar el backoff del gateway.
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
            // GatewayPublisher devuelve objeto con payloadHash/eventId; KafkaService
            // devuelve true. markPublished tolera ambos.
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

module.exports = { OutboxPublisher };