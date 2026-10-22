// Deduplicacion de eventos externos (ADR #25).
//
// tryMarkProcessed se llama DENTRO de la transaccion que ejecuta los
// efectos del evento. ON CONFLICT DO NOTHING convierte el chequeo de
// duplicado en una sola operacion: si rowCount es 0, el evento ya se
// proceso antes y la transaccion debe hacer ROLLBACK sin side effects.
class EventosProcesadosRepository {
  constructor(pool) {
    this.pool = pool;
  }

  // Devuelve true si el evento es nuevo (fresco), false si ya estaba
  // registrado (duplicado). No lanza en caso de duplicado — es flujo normal.
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

  async findById(eventId) {
    const result = await this.pool.query(
      `SELECT event_id, source, event_type, causation_id, processed_at
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
      processedAt: row.processed_at,
    };
  }
}

module.exports = { EventosProcesadosRepository };
