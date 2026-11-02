// Factory de resultados: recibe los { type, payload } que devuelven las reglas
// de un listener y ejecuta el handler registrado para cada type.
//
// Todos los resultados de un evento van en una sola transaccion: se aplican
// juntos o ninguno. Cada handler recibe el mismo client y no abre otra
// transaccion. Lo que tiene que salir hacia otro sistema no se llama desde
// aca: se deja en el outbox.
//
// Un type sin handler falla antes de abrir la transaccion, sin escribir nada.
// Cualquier error se propaga al listener: no se confirma el offset y el
// mensaje se reentrega.
class OutcomeFactory {
  constructor(pool) {
    if (!pool) {
      throw new Error('OutcomeFactory requiere un pool');
    }
    this.pool = pool;
    this.handlers = new Map();
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
    if (!handler) {
      throw new Error(`No hay un handler registrado para ${type}`);
    }
    return handler;
  }

  async process(outcomes, context = {}) {
    if (outcomes.length === 0) return;
    const steps = outcomes.map(({ type, payload }) => ({ handler: this.handlerFor(type), payload }));

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
