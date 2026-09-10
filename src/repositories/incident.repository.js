function mapIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    emergencyType: row.emergency_type,
    priority: row.priority,
    score: row.score,
    reasonCodes: row.reason_codes,
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
}

module.exports = { IncidentRepository, mapIncident };
