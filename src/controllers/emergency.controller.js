const { NotFoundError, ForbiddenError, ValidationError } = require('../errors/app-errors');
const { canCancelEmergency } = require('../auth/authorize');
// Las transiciones válidas viven en el dominio (src/domain/emergency-status.js);
// una transición inválida lanza ConflictError (409).
const { assertTransition } = require('../domain/emergency-status');

class EmergencyController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
  }

  /**
   * Lista paginada de emergencias. Endpoint dispatcher-only (ver requireDispatcher en la ruta).
   * @param {object} query
   */
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

  async validateEmergency(id, user) {
    const actor = user.sub;
    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, 'VALIDATED');

    const { emergency: updated, history } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'VALIDATED',
      actor,
    });

    await this.kafkaService.publishEvent(
      process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
      {
        type: 'EmergencyStatusUpdated',
        emergencyId: updated.id,
        previousStatus: history.previousStatus,
        newStatus: history.newStatus,
        actor,
        timestamp: new Date().toISOString(),
      }
    );

    return { success: true, data: updated };
  }

  async discardEmergency(id, { reason } = {}, user) {
    const actor = user.sub;
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';

    if (!normalizedReason) {
      throw new ValidationError('A discard reason is required');
    }

    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, 'DISCARDED');

    const { emergency: updated, history } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'DISCARDED',
      actor,
      reason: normalizedReason,
    });

    await this.kafkaService.publishEvent(
      process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
      {
        type: 'EmergencyStatusUpdated',
        emergencyId: updated.id,
        previousStatus: history.previousStatus,
        newStatus: history.newStatus,
        actor,
        reason: normalizedReason,
        timestamp: new Date().toISOString(),
      }
    );

    return { success: true, data: updated };
  }

  /**
   * @param {string} id
   * @param {{ reason?: string|null }} options - reason del body; actor sale del JWT
   * @param {{ sub: string }} user - identidad autenticada (req.user)
   */
  async cancelEmergency(id, { reason = null } = {}, user) {
    const actor = user.sub;
    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    if (!canCancelEmergency(user, emergency)) {
      throw new ForbiddenError('You cannot cancel this emergency');
    }

    assertTransition(emergency.status, 'CANCELLED');

    const { emergency: updated, history } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'CANCELLED',
      actor,
      reason,
    });

    await this.kafkaService.publishEvent(
      process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
      {
        type: 'EmergencyStatusUpdated',
        emergencyId: updated.id,
        previousStatus: history.previousStatus,
        newStatus: history.newStatus,
        actor,
        reason,
        timestamp: new Date().toISOString(),
      }
    );

    return { success: true, data: updated };
  }
}

module.exports = { EmergencyController };
