const { secureLog, summarizeEventForLog } = require('../security/secure-log');

class OutboxPublisher {
  constructor(pool, kafkaService, options = {}) {
    this.pool = pool;
    this.kafkaService = kafkaService;
    this.batchSize = options.batchSize || 50;
    this.intervalMs = options.intervalMs || 5000;
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

  async markPublished(id) {
    await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED', published_at = now(), locked_at = NULL, last_error = NULL
       WHERE id = $1`,
      [id]
    );
  }

  async markFailed(id, error) {
    await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PENDING', available_at = now() + interval '30 seconds',
           locked_at = NULL, last_error = $2
       WHERE id = $1`,
      [id, String(error.message || error).slice(0, 2000)]
    );
  }

  async runOnce() {
    if (this.running || !this.kafkaService.isEnabled()) return 0;
    this.running = true;
    let published = 0;
    try {
      const events = await this.claimBatch();
      for (const event of events) {
        try {
          const sent = await this.kafkaService.publishEvent(event.topic, event.payload);
          if (!sent) throw new Error('Kafka disabled or not connected');
          await this.markPublished(event.id);
          published += 1;
        } catch (error) {
          await this.markFailed(event.id, error);
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