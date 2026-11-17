const { randomUUID } = require('node:crypto');
const { ConflictError } = require('../errors/app-errors');
const { secureLog } = require('../security/secure-log');

const MAX_SAVED_LOCATIONS_PER_USER = 20;

const EMPTY_SENSITIVE = {
  phone: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  medicalCondition: '',
};

function mapProfile(row, locationCrypto) {
  if (!row) {
    return {
      name: '',
      ...EMPTY_SENSITIVE,
    };
  }

  let sensitive = { ...EMPTY_SENSITIVE };
  if (row.sensitive_encrypted && locationCrypto) {
    try {
      const parsed = locationCrypto.decryptJson(row.sensitive_encrypted);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        sensitive = {
          phone: typeof parsed.phone === 'string' ? parsed.phone : '',
          emergencyContactName:
            typeof parsed.emergencyContactName === 'string' ? parsed.emergencyContactName : '',
          emergencyContactPhone:
            typeof parsed.emergencyContactPhone === 'string' ? parsed.emergencyContactPhone : '',
          medicalCondition:
            typeof parsed.medicalCondition === 'string' ? parsed.medicalCondition : '',
        };
      }
    } catch (err) {
      secureLog('warn', 'Citizen profile ciphertext could not be decrypted', {
        userId: row.user_id,
        message: err.message,
      });
      sensitive = { ...EMPTY_SENSITIVE };
    }
  }

  return {
    name: row.display_name || '',
    ...sensitive,
    updatedAt: row.updated_at,
  };
}

function mapSavedLocation(row, locationCrypto) {
  if (!row) return null;
  let address = '';
  let lat = null;
  let lng = null;
  if (row.location_encrypted && locationCrypto) {
    try {
      const parsed = locationCrypto.decryptJson(row.location_encrypted);
      address = typeof parsed.address === 'string' ? parsed.address : '';
      lat = typeof parsed.latitude === 'number' && !Number.isNaN(parsed.latitude)
        ? parsed.latitude
        : null;
      lng = typeof parsed.longitude === 'number' && !Number.isNaN(parsed.longitude)
        ? parsed.longitude
        : null;
    } catch (err) {
      secureLog('warn', 'Citizen saved location ciphertext could not be decrypted', {
        savedLocationId: row.id,
        userId: row.user_id,
        message: err.message,
      });
      address = '';
      lat = null;
      lng = null;
    }
  }
  return {
    id: row.id,
    label: row.label,
    address,
    lat,
    lng,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class CitizenProfileRepository {
  constructor(pool, { locationCrypto } = {}) {
    if (!pool) {
      throw new Error('CitizenProfileRepository requires a database pool');
    }
    if (!locationCrypto || typeof locationCrypto.encryptJson !== 'function') {
      throw new Error('CitizenProfileRepository requires locationCrypto with encryptJson/decryptJson');
    }
    this.pool = pool;
    this.locationCrypto = locationCrypto;
  }

  async getProfile(userId) {
    const result = await this.pool.query(
      `SELECT user_id, display_name, sensitive_encrypted, created_at, updated_at
       FROM citizen_profiles
       WHERE user_id = $1`,
      [userId]
    );
    return mapProfile(result.rows[0], this.locationCrypto);
  }

  async upsertProfile(userId, data) {
    const displayName = typeof data.name === 'string' ? data.name.trim().slice(0, 120) : '';
    const sensitive = {
      phone: typeof data.phone === 'string' ? data.phone.trim().slice(0, 40) : '',
      emergencyContactName:
        typeof data.emergencyContactName === 'string'
          ? data.emergencyContactName.trim().slice(0, 120)
          : '',
      emergencyContactPhone:
        typeof data.emergencyContactPhone === 'string'
          ? data.emergencyContactPhone.trim().slice(0, 40)
          : '',
      medicalCondition:
        typeof data.medicalCondition === 'string'
          ? data.medicalCondition.trim().slice(0, 140)
          : '',
    };

    const sensitiveEncrypted = this.locationCrypto.encryptJson(sensitive);

    const result = await this.pool.query(
      `INSERT INTO citizen_profiles (user_id, display_name, sensitive_encrypted, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         sensitive_encrypted = EXCLUDED.sensitive_encrypted,
         updated_at = now()
       RETURNING user_id, display_name, sensitive_encrypted, created_at, updated_at`,
      [userId, displayName, sensitiveEncrypted]
    );

    return mapProfile(result.rows[0], this.locationCrypto);
  }

  async listSavedLocations(userId) {
    const result = await this.pool.query(
      `SELECT id, user_id, label, location_encrypted, created_at, updated_at
       FROM citizen_saved_locations
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId]
    );
    return result.rows.map((row) => mapSavedLocation(row, this.locationCrypto));
  }

  async addSavedLocation(userId, { label, address, lat, lng } = {}) {
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM citizen_saved_locations
       WHERE user_id = $1`,
      [userId]
    );
    const count = countResult.rows[0]?.count ?? 0;
    if (count >= MAX_SAVED_LOCATIONS_PER_USER) {
      throw new ConflictError(
        `Llegaste al máximo de ${MAX_SAVED_LOCATIONS_PER_USER} ubicaciones guardadas`
      );
    }

    const id = randomUUID();
    const trimmedLabel = typeof label === 'string' ? label.trim().slice(0, 80) : '';
    const trimmedAddress = typeof address === 'string' ? address.trim().slice(0, 240) : '';
    const latitude = typeof lat === 'number' && !Number.isNaN(lat) ? lat : null;
    const longitude = typeof lng === 'number' && !Number.isNaN(lng) ? lng : null;

    const locationEncrypted = this.locationCrypto.encryptJson({
      address: trimmedAddress,
      latitude,
      longitude,
    });

    const result = await this.pool.query(
      `INSERT INTO citizen_saved_locations
         (id, user_id, label, location_encrypted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       RETURNING id, user_id, label, location_encrypted, created_at, updated_at`,
      [id, userId, trimmedLabel, locationEncrypted]
    );

    return mapSavedLocation(result.rows[0], this.locationCrypto);
  }

  async updateSavedLocation(userId, id, changes = {}) {
    const existing = await this.pool.query(
      `SELECT id, user_id, label, location_encrypted, created_at, updated_at
       FROM citizen_saved_locations
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!existing.rows[0]) return null;

    const current = mapSavedLocation(existing.rows[0], this.locationCrypto);
    const nextLabel = changes.label !== undefined
      ? String(changes.label).trim().slice(0, 80)
      : current.label;
    const nextAddress = changes.address !== undefined
      ? String(changes.address).trim().slice(0, 240)
      : current.address;
    let nextLat = current.lat;
    if (changes.lat !== undefined) {
      nextLat = typeof changes.lat === 'number' && !Number.isNaN(changes.lat) ? changes.lat : null;
    }
    let nextLng = current.lng;
    if (changes.lng !== undefined) {
      nextLng = typeof changes.lng === 'number' && !Number.isNaN(changes.lng) ? changes.lng : null;
    }

    const locationEncrypted = this.locationCrypto.encryptJson({
      address: nextAddress,
      latitude: nextLat,
      longitude: nextLng,
    });

    const result = await this.pool.query(
      `UPDATE citizen_saved_locations
       SET label = $3,
           location_encrypted = $4,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, user_id, label, location_encrypted, created_at, updated_at`,
      [id, userId, nextLabel, locationEncrypted]
    );

    return mapSavedLocation(result.rows[0], this.locationCrypto);
  }

  async removeSavedLocation(userId, id) {
    const result = await this.pool.query(
      `DELETE FROM citizen_saved_locations
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );
    return result.rowCount > 0;
  }

  /**
   * Minimización: borra ciphertext sensible de perfiles no actualizados
   * en `retentionDays` días (display_name se conserva).
   */
  async anonymizeStaleProfiles(retentionDays) {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('retentionDays must be a positive number');
    }

    const result = await this.pool.query(
      `UPDATE citizen_profiles
       SET sensitive_encrypted = NULL,
           updated_at = now()
       WHERE sensitive_encrypted IS NOT NULL
         AND updated_at < now() - make_interval(days => $1::int)
       RETURNING user_id`,
      [Math.floor(days)]
    );

    return {
      anonymizedCount: result.rowCount,
      userIds: result.rows.map((r) => r.user_id),
    };
  }

  /**
   * Minimización: elimina ubicaciones guardadas sin tocar en `retentionDays`.
   */
  async deleteStaleSavedLocations(retentionDays) {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('retentionDays must be a positive number');
    }

    const result = await this.pool.query(
      `DELETE FROM citizen_saved_locations
       WHERE updated_at < now() - make_interval(days => $1::int)
       RETURNING id`,
      [Math.floor(days)]
    );

    return {
      deletedCount: result.rowCount,
      ids: result.rows.map((r) => r.id),
    };
  }
}

module.exports = {
  CitizenProfileRepository,
  mapProfile,
  mapSavedLocation,
  EMPTY_SENSITIVE,
  MAX_SAVED_LOCATIONS_PER_USER,
};
