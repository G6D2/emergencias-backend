const { isUuid } = require('../utils/uuid');

function permanentError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

function markTransient(error) {
  error.transient = true;
  return error;
}

// causation_id tambien es uuid, pero es opcional (trazabilidad): uno mal
// formado se guarda como null en vez de hacer descartar el evento entero.
function causationIdOf(metadata) {
  return isUuid(metadata.causationId) ? metadata.causationId : null;
}

// Factory de resultados: recibe los { type, payload } que devuelven las reglas
// de un listener y ejecuta el handler registrado para cada type.
//
// Todos los resultados de un evento van en una sola transaccion: se aplican
// juntos o ninguno. Si se configura dedupRepo, el primer paso de la transaccion
// es tryMarkProcessed: si el eventId ya fue procesado, hace ROLLBACK y retorna
// sin side effects (idempotencia garantizada).
//
// Un type sin handler o un eventId que no es UUID fallan antes de abrir la
// transaccion, sin escribir nada. Cualquier error se propaga al listener, que
// decide si es transitorio (reentrega) o permanente (recordDiscard y el offset
// avanza). Los errores de conexion se marcan aca como transitorios: pg los
// tira sin SQLSTATE y el clasificador decide solo por codigo.
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

  // Sin conexion no se ejecuto nada: reintentar siempre es seguro.
  async connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw markTransient(error);
    }
  }

  async process(outcomes, context = {}) {
    const hasDedupWork = this.dedupRepo && context.metadata?.eventId;
    if (outcomes.length === 0 && !hasDedupWork) return;

    // eventos_procesados.event_id es uuid: con otro valor el INSERT de dedup
    // falla igual en cada reentrega. Se descarta sin abrir la transaccion.
    if (hasDedupWork && !isUuid(context.metadata.eventId)) {
      throw permanentError('metadata.eventId no es un UUID');
    }

    // Verificar handlers antes de abrir la transaccion.
    const steps = outcomes.map(({ type, payload }) => ({ handler: this.handlerFor(type), payload }));

    const client = await this.connect();
    let brokenConnection;
    try {
      await client.query('BEGIN');

      if (hasDedupWork) {
        const { metadata } = context;
        const fresh = await this.dedupRepo.tryMarkProcessed(client, {
          eventId: metadata.eventId,
          source: metadata.source || 'unknown',
          eventType: metadata.eventType || 'unknown',
          causationId: causationIdOf(metadata),
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
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Si ni el ROLLBACK anda, se cortó la conexión: el error no es del
        // evento y se reintenta (el dedup hace segura la reentrega aunque el
        // COMMIT haya llegado a aplicarse). La conexión se descarta del pool.
        brokenConnection = rollbackError;
        markTransient(error);
      }
      throw error;
    } finally {
      client.release(brokenConnection);
    }
  }

  // Registra un evento descartado por un error permanente, fuera de la
  // transaccion que hizo ROLLBACK. Sin dedupRepo o sin un eventId UUID no hay
  // donde anotarlo (queda solo en el log). Devuelve true si quedo registrado.
  async recordDiscard(context = {}, reason) {
    const metadata = context.metadata || {};
    if (!this.dedupRepo || !isUuid(metadata.eventId)) return false;
    const client = await this.connect();
    try {
      return await this.dedupRepo.markDiscarded(client, {
        eventId: metadata.eventId,
        source: metadata.source || 'unknown',
        eventType: metadata.eventType || 'unknown',
        causationId: causationIdOf(metadata),
        reason: String(reason || 'sin motivo').slice(0, 500),
      });
    } finally {
      client.release();
    }
  }
}

module.exports = { OutcomeFactory };
