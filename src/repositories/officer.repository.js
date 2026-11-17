function mapOfficer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    badgeNumber: row.badge_number,
    location: row.location_label,
    distance: row.distance_label,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class OfficerRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findAll({ status } = {}) {
    const values = [];
    let sql = 'SELECT * FROM officers';
    if (status) {
      values.push(status);
      sql += ` WHERE status = $${values.length}`;
    }
    sql += ' ORDER BY name ASC';
    const result = await this.pool.query(sql, values);
    return result.rows.map(mapOfficer);
  }
}

module.exports = { OfficerRepository, mapOfficer };
