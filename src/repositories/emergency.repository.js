// Mapea filas de Postgres (snake_case) a objetos JS (camelCase) para no filtrar
// el detalle de columnas de la base fuera del repository.
function mapEmergency(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    latitude: row.latitude,
    longitude: row.longitude,
    description: row.description,
    severity: row.severity,
    status: row.status,
    assignedOfficerId: row.assigned_officer_id,
    emergencyType: row.emergency_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHistorialEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    emergenciaId: row.emergencia_id,
    estadoAnterior: row.estado_anterior,
    estadoNuevo: row.estado_nuevo,
    actor: row.actor,
    motivo: row.motivo,
    createdAt: row.created_at,
  };
}

// Repositorio de persistencia para emergencias (Task 4).
// No conoce Kafka, controllers ni HTTP: solo SQL. Pensado para que Task 2 lo
// inyecte donde hoy usa el Map en memoria de PanicButtonController.
class EmergencyRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create({ id, userId, latitude, longitude, description, severity, status }) {
    const result = await this.pool.query(
      `INSERT INTO emergencias (id, user_id, latitude, longitude, description, severity, status)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'PENDIENTE'))
       RETURNING *`,
      [id, userId, latitude, longitude, description || null, severity || null, status || null]
    );
    return mapEmergency(result.rows[0]);
  }

  async findById(id) {
    const result = await this.pool.query('SELECT * FROM emergencias WHERE id = $1', [id]);
    return mapEmergency(result.rows[0]);
  }

  async findAll() {
    const result = await this.pool.query('SELECT * FROM emergencias ORDER BY created_at DESC');
    return result.rows.map(mapEmergency);
  }

  async findPage({ statuses, severity, from, to, assignedOfficerId, emergencyType, page, limit, sortBy, order }) {
    const conditions = [];
    const values = [];

    function addCondition(sql, value) {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    }

    if (statuses.length > 0) addCondition('status = ANY(?)', statuses);
    if (severity) addCondition('severity = ?', severity);
    if (from) addCondition('created_at >= ?', from);
    if (to) addCondition('created_at <= ?', to);
    if (assignedOfficerId) addCondition('assigned_officer_id = ?', assignedOfficerId);
    if (emergencyType) addCondition('emergency_type = ?', emergencyType);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const sortExpression = sortBy === 'priority'
      ? "CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END"
      : 'created_at';

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM emergencias ${where}`,
      values
    );
    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT * FROM emergencias ${where}
       ORDER BY ${sortExpression} ${direction}, created_at ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    return { emergencies: result.rows.map(mapEmergency), total: countResult.rows[0].total };
  }

  async findHistorialByEmergencyId(emergencyId) {
    const result = await this.pool.query(
      'SELECT * FROM emergencia_estado_historial WHERE emergencia_id = $1 ORDER BY created_at ASC',
      [emergencyId]
    );
    return result.rows.map(mapHistorialEntry);
  }

  // Actualiza el estado y registra el historial en una única transacción:
  // si cualquiera de los dos pasos falla, no queda ni el cambio de estado
  // ni el registro de historial (ROLLBACK). La validez de la transición
  // (qué estados pueden pasar a cuáles) es responsabilidad de Task 9.
  async updateStatus(id, { newStatus, actor = null, reason = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query('SELECT status FROM emergencias WHERE id = $1 FOR UPDATE', [id]);
      if (current.rows.length === 0) {
        throw new Error(`Emergency with ID ${id} not found`);
      }
      const previousStatus = current.rows[0].status;

      const updated = await client.query(
        'UPDATE emergencias SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [newStatus, id]
      );

      const historial = await client.query(
        `INSERT INTO emergencia_estado_historial (emergencia_id, estado_anterior, estado_nuevo, actor, motivo)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, previousStatus, newStatus, actor, reason]
      );

      await client.query('COMMIT');

      return { emergency: mapEmergency(updated.rows[0]), historial: mapHistorialEntry(historial.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { EmergencyRepository };
