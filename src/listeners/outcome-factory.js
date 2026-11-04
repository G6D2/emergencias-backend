// Factory de resultados: recibe los { type, payload } que devuelven las reglas
// de un listener y ejecuta el handler registrado para cada type.
//
// Todos los resultados de un evento van en una sola transaccion: se aplican
// juntos o ninguno. Si se configura dedupRepo, el primer paso de la transaccion
// es tryMarkProcessed: si el eventId ya fue procesado, hace ROLLBACK y retorna
// sin side effects (idempotencia garantizada).
//
// Un type sin handler falla antes de abrir la transaccion, sin escribir nada.
// Cualquier error se propaga al listener: no se confirma el offset y el
// mensaje se reentrega.
class OutcomeFactory {
  constructor(pool, options = {}) {
    if (!pool) throw new Error('OutcomeFactory requiere un pool');
    this.pool = pool;
    this.handlers = new Map();
    this.dedupRepo = options.dedupRepo || null;
  }

  register(type, handler) {
    if (typeof type !== 'string' || !type) {
      throw new Error('OutcomeFactory.register() requiere un type');
    }
    if (typeof handler !== 'function') {
      throw new Error(`El handler de ${type} debe ser una funcion`);
    }
    if (this.handlers.has(type)) {
      throw new Error(`Ya hay un handler registrado para ${type}`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  handlerFor(type) {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`No hay un handler registrado para ${type}`);
    return handler;
  }

  async process(outcomes, context = {}) {
    const hasDedupWork = this.dedupRepo && context.metadata?.eventId;
    if (outcomes.length === 0 && !hasDedupWork) return;

    // Verificar handlers antes de abrir la transaccion.
    const steps = outcomes.map(({ type, payload }) => ({ handler: this.handlerFor(type), payload }));

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (hasDedupWork) {
        const { metadata } = context;
        const fresh = await this.dedupRepo.tryMarkProcessed(client, {
          eventId: metadata.eventId,
          source: metadata.source || 'unknown',
          eventType: metadata.eventType || 'unknown',
          causationId: metadata.causationId || null,
        });
        if (!fresh) {
          await client.query('ROLLBACK');
          return;
        }
      }

      for (const { handler, payload } of steps) {
        await handler(client, payload, context);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { OutcomeFactory };
