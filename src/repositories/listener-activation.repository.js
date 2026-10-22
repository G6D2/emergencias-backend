// Issue #71 (ADR #25): persiste el momento de la primera activacion del
// listener de integracion EDA. Es una tabla singleton (id = 1) para que el
// INSERT ON CONFLICT DO NOTHING funcione como candado natural entre pods.
class ListenerActivationRepository {
  constructor(pool) {
    this.pool = pool;
  }

  // SELECT puro, no toca estado. Devuelve null si todavia no hubo activacion.
  async get(executor) {
    const client = executor || this.pool;
    const result = await client.query(
      `SELECT first_activated_at, discarded_count
       FROM listener_activation
       WHERE id = 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      firstActivatedAt: row.first_activated_at,
      discardedCount: row.discarded_count,
    };
  }

  // Intenta insertar la fila singleton. Si rowCount es 1 => soy el pod que
  // gano la primera activacion y me toca descartar los PENDING previos.
  // Si rowCount es 0 => otro pod ya activo; devolver false y leer el valor.
  async tryInsertFirstActivation(executor) {
    const client = executor || this.pool;
    const result = await client.query(
      `INSERT INTO listener_activation (id, first_activated_at)
       VALUES (1, now())
       ON CONFLICT (id) DO NOTHING
       RETURNING first_activated_at`
    );
    if (result.rowCount === 0) return null;
    return { firstActivatedAt: result.rows[0].first_activated_at };
  }

  async setDiscardedCount(executor, count) {
    const client = executor || this.pool;
    await client.query(
      `UPDATE listener_activation SET discarded_count = $1 WHERE id = 1`,
      [count]
    );
  }
}

module.exports = { ListenerActivationRepository };
