const { ValidationError } = require('../errors/app-errors');

// Mismos valores que el CHECK officers_status_check (V11).
const OFFICER_STATUSES = Object.freeze(['disponible', 'ocupado']);

class OfficerController {
  constructor(officerRepository) {
    this.officerRepository = officerRepository;
  }

  async listOfficers(query = {}) {
    // Sin status (o vacío) no se filtra. Un valor fuera del catálogo daba 200
    // con la lista vacía: ahora es 400.
    const raw = typeof query.status === 'string' ? query.status.trim() : query.status;
    const status = raw === undefined || raw === '' ? undefined : raw;
    if (status !== undefined && !OFFICER_STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of: ${OFFICER_STATUSES.join(', ')}`);
    }
    const officers = await this.officerRepository.findAll({ status });
    return { data: officers };
  }
}

module.exports = { OfficerController, OFFICER_STATUSES };
