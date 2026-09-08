const { NotFoundError, ConflictError, ForbiddenError, ValidationError } = require('../errors/app-errors');
const { canCancelEmergency } = require('../auth/authorize');
const { isValidSeverity } = require('../domain/severity');

// Estados desde los que un citizen puede cancelar su propia emergency.
// DISCARDED lo decide el Dispatcher; no pasa por este endpoint.
const CANCELABLE_STATUSES = new Set(['PENDING', 'VALIDATED']);

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
    if (query.severity && !isValidSeverity(query.severity)) {
      throw new ValidationError('severity must be one of: low, medium, high, critical');
    }
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

    if (emergency.status !== 'PENDING') {
      throw new ConflictError(
        `Emergency in status ${emergency.status} cannot be validated`
      );
    }

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

    if (emergency.status !== 'PENDING') {
      throw new ConflictError(
        `Emergency in status ${emergency.status} cannot be discarded`
      );
    }

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

    if (!CANCELABLE_STATUSES.has(emergency.status)) {
      throw new ConflictError(
        `Emergency in status ${emergency.status} cannot be cancelled`
      );
    }

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
