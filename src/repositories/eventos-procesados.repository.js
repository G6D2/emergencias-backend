// Deduplicacion de eventos externos (issue #65).
//
// tryMarkProcessed se llama DENTRO de la transaccion que ejecuta los
// efectos del evento. ON CONFLICT DO NOTHING convierte el chequeo en una
// sola operacion: si rowCount es 0, el evento ya fue procesado antes y
// la transaccion debe hacer ROLLBACK sin side effects.
class EventosProcesadosRepository {
  constructor(pool) {
    this.pool = pool;
  }

  // Devuelve true si el evento es nuevo, false si ya estaba registrado.
  // No lanza en caso de duplicado — es flujo normal, no un error.
  async tryMarkProcessed(executor, { eventId, source, eventType, causationId = null }) {
    if (!eventId) throw new Error('tryMarkProcessed requiere eventId');
    if (!source) throw new Error('tryMarkProcessed requiere source');
    if (!eventType) throw new Error('tryMarkProcessed requiere eventType');

    const client = executor || this.pool;
    const result = await client.query(
      `INSERT INTO eventos_procesados (event_id, source, event_type, causation_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, source, eventType, causationId]
    );
    return result.rowCount === 1;
  }

  // Un evento descartado por un error permanente queda registrado con su
  // motivo: no se vuelve a procesar aunque Kafka lo reentregue.
  async markDiscarded(executor, { eventId, source, eventType, causationId = null, reason }) {
    if (!eventId) throw new Error('markDiscarded requiere eventId');
    if (!reason) throw new Error('markDiscarded requiere reason');

    const client = executor || this.pool;
    const result = await client.query(
      `INSERT INTO eventos_procesados (event_id, source, event_type, causation_id, status, discard_reason)
       VALUES ($1, $2, $3, $4, 'DISCARDED', $5)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, source || 'unknown', eventType || 'unknown', causationId, reason]
    );
    return result.rowCount === 1;
  }

  // Eventos externos más recientes primero, procesados o descartados. Si el
  // mensaje es el último que escribió un contexto de zona, trae la referencia
  // de ese contexto (el eventoId de Espacios). No devuelve el contenido del
  // evento. Para el tablero de pruebas: GET /api/received-events.
  async findRecent({ limit = 50 } = {}) {
    const result = await this.pool.query(
      `SELECT e.event_id, e.source, e.event_type, e.status, e.discard_reason, e.processed_at,
              c.referencia_externa AS contexto_referencia
       FROM eventos_procesados e
       LEFT JOIN contexto_zona c ON c.causation_id = e.event_id
       ORDER BY e.processed_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      source: row.source,
      eventType: row.event_type,
      status: row.status,
      discardReason: row.discard_reason ?? null,
      processedAt: row.processed_at,
      contextoReferencia: row.contexto_referencia ?? null,
    }));
  }

  async findById(eventId) {
    const result = await this.pool.query(
      `SELECT event_id, source, event_type, causation_id, status, discard_reason, processed_at
       FROM eventos_procesados
       WHERE event_id = $1`,
      [eventId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      eventId: row.event_id,
      source: row.source,
      eventType: row.event_type,
      causationId: row.causation_id,
      status: row.status,
      discardReason: row.discard_reason,
      processedAt: row.processed_at,
    };
  }
}

module.exports = { EventosProcesadosRepository };
