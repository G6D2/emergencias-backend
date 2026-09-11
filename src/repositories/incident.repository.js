const { NotFoundError } = require('../errors/app-errors');

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

  async findActive() {
    const result = await this.pool.query(
      `SELECT * FROM incidents i
       WHERE EXISTS (
         SELECT 1 FROM emergencies e
         WHERE e.incident_id = i.id
           AND e.status NOT IN ('CLOSED', 'CANCELLED', 'DISCARDED')
       )
       ORDER BY i.created_at DESC`
    );
    return result.rows.map(mapIncident);
  }

  async addMember(incidentId, emergencyId) {
    return this.emergencyRepository.setIncidentId(emergencyId, incidentId);
  }

  async updateScoring(incidentId, { priority, score, reasonCodes, factors, algorithmVersion }) {
    const result = await this.pool.query(
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
    if (result.rows.length === 0) {
      throw new NotFoundError(`Incident with ID ${incidentId} not found`);
    }
    return mapIncident(result.rows[0]);
  }
}

module.exports = { IncidentRepository, mapIncident };
