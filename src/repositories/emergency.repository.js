const { NotFoundError } = require('../errors/app-errors');

// Pasa filas de Postgres (snake_case) a objetos JS (camelCase) para que el
// detalle de las columnas no se filtre afuera del repository.
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

function mapHistoryEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    emergencyId: row.emergency_id,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

// Repository de persistencia de emergencies.
// No sabe nada de Kafka, controllers ni HTTP: solo SQL.
class EmergencyRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create({ id, userId, latitude, longitude, description, severity, status }) {
    const result = await this.pool.query(
      `INSERT INTO emergencies (id, user_id, latitude, longitude, description, severity, status)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'PENDING'))
       RETURNING *`,
      [id, userId, latitude, longitude, description || null, severity || null, status || null]
    );
    return mapEmergency(result.rows[0]);
  }

  async findById(id) {
    const result = await this.pool.query('SELECT * FROM emergencies WHERE id = $1', [id]);
    return mapEmergency(result.rows[0]);
  }

  async findAll() {
    const result = await this.pool.query('SELECT * FROM emergencies ORDER BY created_at DESC');
    return result.rows.map(mapEmergency);
  }

  async findHistoryByEmergencyId(emergencyId) {
    const result = await this.pool.query(
      'SELECT * FROM emergency_status_history WHERE emergency_id = $1 ORDER BY created_at ASC',
      [emergencyId]
    );
    return result.rows.map(mapHistoryEntry);
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
      `SELECT COUNT(*)::int AS total FROM emergencies ${where}`,
      values
    );
    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT * FROM emergencies ${where}
       ORDER BY ${sortExpression} ${direction}, created_at ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    return { emergencies: result.rows.map(mapEmergency), total: countResult.rows[0].total };
  }

  // Actualiza el status y deja el historial en la misma transacción.
  // Si falla cualquiera de los dos pasos, hace ROLLBACK. Las transiciones
  // válidas las chequean los controllers.
  async updateStatus(id, { newStatus, actor = null, reason = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query('SELECT status FROM emergencies WHERE id = $1 FOR UPDATE', [id]);
      if (current.rows.length === 0) {
        throw new NotFoundError(`Emergency with ID ${id} not found`);
      }
      const previousStatus = current.rows[0].status;

      const updated = await client.query(
        'UPDATE emergencies SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [newStatus, id]
      );

      const history = await client.query(
        `INSERT INTO emergency_status_history (emergency_id, previous_status, new_status, actor, reason)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, previousStatus, newStatus, actor, reason]
      );

      await client.query('COMMIT');

      return { emergency: mapEmergency(updated.rows[0]), history: mapHistoryEntry(history.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { EmergencyRepository };
