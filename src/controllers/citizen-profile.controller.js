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
    throw new ValidationError(`${key} tiene que ser texto`);
  }
  return body[key];
}

function parseOptionalCoord(raw, fieldName) {
  if (raw === undefined) {
    return { present: false };
  }
  if (raw === null || raw === '') {
    return { present: true, value: null };
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new ValidationError(`${fieldName} tiene que ser un número`);
  }
  return { present: true, value };
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
      throw new ValidationError('El cuerpo del pedido tiene que ser un objeto JSON');
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
      throw new ValidationError('El cuerpo del pedido tiene que ser un objeto JSON');
    }

    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!label || !address) {
      throw new ValidationError('label y address son obligatorios');
    }

    const lat = parseOptionalCoord(body.lat, 'lat');
    const lng = parseOptionalCoord(body.lng, 'lng');

    const entry = await this.repo.addSavedLocation(user.sub, {
      label,
      address,
      lat: lat.present ? lat.value : null,
      lng: lng.present ? lng.value : null,
    });
    return { data: entry };
  }

  async updateSavedLocation(user, id, body = {}) {
    assertUuid(id, 'El id de la ubicación guardada tiene que ser un UUID válido');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('El cuerpo del pedido tiene que ser un objeto JSON');
    }

    const changes = {};
    if (body.label !== undefined) changes.label = body.label;
    if (body.address !== undefined) changes.address = body.address;

    const lat = parseOptionalCoord(body.lat, 'lat');
    if (lat.present) changes.lat = lat.value;
    const lng = parseOptionalCoord(body.lng, 'lng');
    if (lng.present) changes.lng = lng.value;

    const entry = await this.repo.updateSavedLocation(user.sub, id, changes);
    if (!entry) {
      throw new NotFoundError('No se encontró la ubicación guardada');
    }
    return { data: entry };
  }

  async removeSavedLocation(user, id) {
    assertUuid(id, 'El id de la ubicación guardada tiene que ser un UUID válido');
    const ok = await this.repo.removeSavedLocation(user.sub, id);
    if (!ok) {
      throw new NotFoundError('No se encontró la ubicación guardada');
    }
    return { data: { id } };
  }
}

module.exports = { CitizenProfileController };
