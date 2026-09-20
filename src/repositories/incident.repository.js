const { NotFoundError } = require('../errors/app-errors');
const { buildEmergencyPrioritizedEvent } = require('../services/emergency-events');

function mapIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    emergencyType: row.emergency_type,
    priority: row.priority,
    score: row.score,
    reasonCodes: row.reason_codes,
    factors: row.factors,
    algorithmVersion: row.algorithm_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class IncidentRepository {
  constructor(pool, emergencyRepository) {
    this.pool = pool;
    this.emergencyRepository = emergencyRepository;
  }

  async create({ emergencyType, priority, score, reasonCodes, algorithmVersion }) {
    const result = await this.pool.query(
      `INSERT INTO incidents (emergency_type, priority, score, reason_codes, algorithm_version)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [
        emergencyType || null,
        priority || null,
        score != null ? score : null,
        JSON.stringify(reasonCodes != null ? reasonCodes : null),
        algorithmVersion || null,
      ]
    );
    return mapIncident(result.rows[0]);
  }

  // "Activo" = tiene al menos una emergencia miembro que no está en un
  // status terminal. reportCount cuenta TODAS las emergencias vinculadas
  // (no solo las activas): es la misma definición que usa
  // emergency.repository.js#mapIncidentSummary para el incident embebido en
  // GET /api/emergencies, para que ambos endpoints no muestren números
  // distintos para el mismo incidente.
  static ACTIVE_INCIDENT_WHERE = `
    WHERE EXISTS (
      SELECT 1 FROM emergencies e
      WHERE e.incident_id = i.id
        AND e.status NOT IN ('CLOSED', 'CANCELLED', 'DISCARDED')
    )`;

  /**
   * Lista paginada de incidentes activos (dispatcher, GET /api/incidents),
   * con la cantidad de emergencias vinculadas a cada uno.
   */
  async findActivePage({ page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM incidents i ${IncidentRepository.ACTIVE_INCIDENT_WHERE}`
    );

    const result = await this.pool.query(
      `SELECT i.*,
              (SELECT COUNT(*)::int FROM emergencies e2 WHERE e2.incident_id = i.id) AS emergency_count
       FROM incidents i
       ${IncidentRepository.ACTIVE_INCIDENT_WHERE}
       ORDER BY i.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      incidents: result.rows.map((row) => ({
        ...mapIncident(row),
        emergencyCount: row.emergency_count,
      })),
      total: countResult.rows[0].total,
    };
  }

  /**
   * Detalle de un incidente (dispatcher, GET /api/incidents/:id): el
   * incidente más sus emergencias miembro (id, status, emergencyType,
   * createdAt — SIN coordenadas: el dispatcher ya las ve en el detalle de
   * cada emergencia si las necesita, este endpoint es un resumen operativo).
   * Devuelve null si el incidente no existe.
   */
  async findByIdWithMembers(id) {
    const incidentResult = await this.pool.query('SELECT * FROM incidents WHERE id = $1', [id]);
    if (incidentResult.rows.length === 0) return null;

    const membersResult = await this.pool.query(
      `SELECT id, status, emergency_type, created_at
       FROM emergencies
       WHERE incident_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    return {
      ...mapIncident(incidentResult.rows[0]),
      members: membersResult.rows.map((row) => ({
        id: row.id,
        status: row.status,
        emergencyType: row.emergency_type,
        createdAt: row.created_at,
      })),
    };
  }

  async addMember(incidentId, emergencyId) {
    return this.emergencyRepository.setIncidentId(emergencyId, incidentId);
  }

  /**
   * Persiste la decisión de scoring del rule-based grouper (tarea #60, parte
   * 2/2) y notifica EmergenciaPriorizada por cada miembro, pero solo si la
   * prioridad del incidente efectivamente cambió (NULL cuenta como "distinto
   * de cualquier valor", así que la primera vez siempre notifica).
   */
  async applyScoringDecision(incidentId, { priority, score, reasonCodes, factors, algorithmVersion, members }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query(
        'SELECT priority FROM incidents WHERE id = $1 FOR UPDATE',
        [incidentId]
      );
      if (current.rows.length === 0) {
        throw new NotFoundError(`Incident with ID ${incidentId} not found`);
      }
      const previousPriority = current.rows[0].priority;

      const updated = await client.query(
        `UPDATE incidents
         SET priority = $1, score = $2, reason_codes = $3::jsonb, factors = $4::jsonb,
             algorithm_version = $5, updated_at = now()
         WHERE id = $6
         RETURNING *`,
        [
          priority || null,
          score != null ? score : null,
          JSON.stringify(reasonCodes != null ? reasonCodes : null),
          JSON.stringify(factors != null ? factors : null),
          algorithmVersion || null,
          incidentId,
        ]
      );

      if (previousPriority !== priority) {
        for (const member of members) {
          await this.emergencyRepository.insertOutboxEvent(
            client,
            {
              topic: process.env.TOPIC_EMERGENCIA_PRIORIZADA || 'emergencias.priorizada',
              payload: (entity, eventId) => buildEmergencyPrioritizedEvent({
                emergencyId: entity.emergencyId,
                correlationId: entity.correlationId,
                incidentId,
                priorityIndividual: entity.priorityIndividual,
                incidentPriority: priority,
                priority: entity.finalPriority,
                score,
                reasonCodes,
                algorithmVersion,
                eventId,
              }),
            },
            member
          );
        }
      }

      await client.query('COMMIT');

      return mapIncident(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { IncidentRepository, mapIncident };
