const { NotFoundError } = require('../errors/app-errors');
const { assertUuid } = require('../utils/uuid');

/**
 * Endpoints de solo lectura para hacer visible al dispatcher el resultado
 * del motor de incidentes (Risk Engine + RuleBasedGrouper, en main vía #36/#41).
 * No hay altas/bajas manuales de incidentes: los crea y actualiza el job de
 * detección.
 */
class IncidentController {
  constructor(incidentRepository) {
    this.incidentRepository = incidentRepository;
  }

  async listIncidents(query = {}) {
    const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);

    const { incidents, total } = await this.incidentRepository.findActivePage({ page, limit });

    return {
      data: incidents,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getIncidentDetail(id) {
    assertUuid(id, 'Incident id must be a valid UUID');

    const incident = await this.incidentRepository.findByIdWithMembers(id);
    if (!incident) {
      throw new NotFoundError(`Incident with ID ${id} not found`);
    }

    return { success: true, data: incident };
  }
}

module.exports = { IncidentController };
