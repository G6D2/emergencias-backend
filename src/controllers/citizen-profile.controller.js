const { ValidationError, NotFoundError } = require('../errors/app-errors');
const { assertUuid } = require('../utils/uuid');

const PROFILE_STRING_FIELDS = [
  ['name', 120],
  ['phone', 40],
  ['emergencyContactName', 120],
  ['emergencyContactPhone', 40],
  ['medicalCondition', 140],
];

function readOptionalString(body, key) {
  if (body[key] === undefined) {
    return undefined;
  }
  if (typeof body[key] !== 'string') {
    throw new ValidationError(`${key} must be a string`);
  }
  return body[key];
}

class CitizenProfileController {
  constructor(citizenProfileRepository) {
    this.repo = citizenProfileRepository;
  }

  async getProfile(user) {
    const profile = await this.repo.getProfile(user.sub);
    return { data: profile };
  }

  async upsertProfile(user, body = {}) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object');
    }

    const payload = {};
    for (const [field] of PROFILE_STRING_FIELDS) {
      const value = readOptionalString(body, field);
      if (value !== undefined) {
        payload[field] = value;
      }
    }

    const profile = await this.repo.upsertProfile(user.sub, {
      name: payload.name ?? '',
      phone: payload.phone ?? '',
      emergencyContactName: payload.emergencyContactName ?? '',
      emergencyContactPhone: payload.emergencyContactPhone ?? '',
      medicalCondition: payload.medicalCondition ?? '',
    });
    return { data: profile };
  }

  async listSavedLocations(user) {
    const locations = await this.repo.listSavedLocations(user.sub);
    return { data: locations };
  }

  async addSavedLocation(user, body = {}) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object');
    }

    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!label || !address) {
      throw new ValidationError('label and address are required');
    }

    const lat = body.lat === undefined || body.lat === null || body.lat === ''
      ? null
      : Number(body.lat);
    const lng = body.lng === undefined || body.lng === null || body.lng === ''
      ? null
      : Number(body.lng);

    if (lat !== null && Number.isNaN(lat)) {
      throw new ValidationError('lat must be a number');
    }
    if (lng !== null && Number.isNaN(lng)) {
      throw new ValidationError('lng must be a number');
    }

    const entry = await this.repo.addSavedLocation(user.sub, {
      label,
      address,
      lat,
      lng,
    });
    return { data: entry };
  }

  async updateSavedLocation(user, id, body = {}) {
    assertUuid(id, 'Saved location id must be a valid UUID');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object');
    }

    const changes = {};
    if (body.label !== undefined) changes.label = body.label;
    if (body.address !== undefined) changes.address = body.address;
    if (body.lat !== undefined) {
      changes.lat = body.lat === null || body.lat === '' ? null : Number(body.lat);
      if (changes.lat !== null && Number.isNaN(changes.lat)) {
        throw new ValidationError('lat must be a number');
      }
    }
    if (body.lng !== undefined) {
      changes.lng = body.lng === null || body.lng === '' ? null : Number(body.lng);
      if (changes.lng !== null && Number.isNaN(changes.lng)) {
        throw new ValidationError('lng must be a number');
      }
    }

    const entry = await this.repo.updateSavedLocation(user.sub, id, changes);
    if (!entry) {
      throw new NotFoundError('Saved location not found');
    }
    return { data: entry };
  }

  async removeSavedLocation(user, id) {
    assertUuid(id, 'Saved location id must be a valid UUID');
    const ok = await this.repo.removeSavedLocation(user.sub, id);
    if (!ok) {
      throw new NotFoundError('Saved location not found');
    }
    return { data: { id } };
  }
}

module.exports = { CitizenProfileController };
