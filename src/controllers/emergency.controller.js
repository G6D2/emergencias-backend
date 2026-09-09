const { NotFoundError, ForbiddenError, ValidationError } = require('../errors/app-errors');
const { canCancelEmergency, userHasGroup } = require('../auth/authorize');
const { GROUPS } = require('../auth/groups');
// Las transiciones válidas viven en el dominio (src/domain/emergency-status.js);
// una transición inválida lanza ConflictError (409).
const { assertTransition } = require('../domain/emergency-status');
const { buildEmergencyStatusUpdatedEvent } = require('../services/emergency-events');
const { assertEmergencyType } = require('../domain/emergency-type');

class EmergencyController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
  }

  /**
   * Lista paginada de emergencias. Endpoint dispatcher-only (ver requireDispatcher en la ruta).
   * @param {object} query
   */
  async listEmergencies(query, user = null) {
    // Un citizen solo ve lo suyo: se ignora cualquier userId del query y se
    // usa el sub del token. Dispatcher (y futuros roles operativos) ven todo.
    const restrictToOwn = Boolean(user) && !userHasGroup(user, GROUPS.DISPATCHER);
    const userId = restrictToOwn ? user.sub : undefined;
    const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
    const statuses = String(query.status || query.statuses || '')
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean);
    const sortBy = query.sortBy === 'priority' ? 'priority' : 'createdAt';
    const order = query.order === 'asc' ? 'asc' : 'desc';
    const { emergencies, total } = await this.emergencyRepository.findPage({
      userId,
      statuses,
      severity: query.severity || query.priority,
      from: query.from,
      to: query.to,
      assignedOfficerId: query.assignedOfficerId,
      // Acepta canónico o alias del front (medical → MEDICA); inválido → 400.
      // `type` se mantiene por compatibilidad con clientes existentes.
      emergencyType: assertEmergencyType(query.emergencyType || query.type),
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

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'VALIDATED',
      actor,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyStatusUpdatedEvent({
            emergency: savedEmergency,
            history: savedHistory,
            actor,
            eventId,
          }),
      },
    });

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

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'DISCARDED',
      actor,
      reason: normalizedReason,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyStatusUpdatedEvent({
            emergency: savedEmergency,
            history: savedHistory,
            actor,
            reason: normalizedReason,
            eventId,
          }),
      },
    });

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

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'CANCELLED',
      actor,
      reason,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyStatusUpdatedEvent({
            emergency: savedEmergency,
            history: savedHistory,
            actor,
            reason,
            eventId,
          }),
      },
    });

    return { success: true, data: updated };
  }
}

module.exports = { EmergencyController };
