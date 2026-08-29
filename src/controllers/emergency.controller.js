const { NotFoundError, ConflictError } = require('../errors/app-errors');

// Estados desde los que un ciudadano puede cancelar su propia emergencia.
// DESCARTADA es una decisión del Dispatcher, no pasa por este endpoint.
const CANCELABLE_STATUSES = new Set(['PENDIENTE', 'VALIDADA']);

class EmergencyController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
  }

  async listEmergencies(query) {
    const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
    const statuses = String(query.status || query.statuses || '')
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean);
    const sortBy = query.sortBy === 'priority' ? 'priority' : 'createdAt';
    const order = query.order === 'asc' ? 'asc' : 'desc';
    const { emergencies, total } = await this.emergencyRepository.findPage({
      statuses,
      severity: query.severity || query.priority,
      from: query.from,
      to: query.to,
      assignedOfficerId: query.assignedOfficerId,
      emergencyType: query.type,
      page,
      limit,
      sortBy,
      order,
    });

    return {
      data: emergencies,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async cancelEmergency(id, { actor = null, reason = null } = {}) {
    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    if (!CANCELABLE_STATUSES.has(emergency.status)) {
      throw new ConflictError(
        `Emergency in status ${emergency.status} cannot be cancelled`
      );
    }

    const { emergency: updated, historial } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'CANCELADA',
      actor,
      reason,
    });

    await this.kafkaService.publishEvent(
      process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
      {
        type: 'EmergenciaEstadoActualizado',
        emergenciaId: updated.id,
        estadoAnterior: historial.estadoAnterior,
        estadoNuevo: historial.estadoNuevo,
        actor,
        motivo: reason,
        timestamp: new Date().toISOString(),
      }
    );

    return { success: true, data: updated };
  }
}

module.exports = { EmergencyController };
