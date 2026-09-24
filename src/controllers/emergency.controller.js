const { NotFoundError, ForbiddenError, ValidationError } = require('../errors/app-errors');
const { canCancelEmergency, canViewEmergency, userHasGroup } = require('../auth/authorize');
const { GROUPS } = require('../auth/groups');
// Las transiciones válidas viven en el dominio (src/domain/emergency-status.js);
// una transición inválida lanza ConflictError (409).
const { assertTransition } = require('../domain/emergency-status');
const { buildEmergencyStatusUpdatedEvent, buildEmergencyClosedEvent } = require('../services/emergency-events');
const { assertEmergencyType } = require('../domain/emergency-type');
const { isValidSeverity } = require('../domain/severity');
const { assertUuid } = require('../utils/uuid');

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
    // incident/effectivePriority son información operativa (a qué incidente
    // fue agrupada la emergencia, con qué prioridad): un citizen NO la ve en
    // su listado, aunque sean sus propias emergencias. El repository las
    // calcula igual para todos (un solo JOIN), se recortan acá.
    const isDispatcher = userHasGroup(user, GROUPS.DISPATCHER);
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

    const data = isDispatcher
      ? emergencies
      // eslint-disable-next-line no-unused-vars
      : emergencies.map(({ incident, effectivePriority, ...rest }) => rest);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Detalle completo de una emergencia (tarea #32): datos principales,
   * ubicación, prioridad, estado actual, oficial asignado e historial de
   * estados. Observaciones y solicitudes de refuerzo todavía no existen en
   * el modelo: se devuelven como listas vacías para que el front pueda
   * pintarlas sin cambios de contrato cuando aparezcan.
   *
   * Reglas de acceso (misma fuente que GET /api/panic-button/:id, vía
   * canViewEmergency): dispatcher ve cualquiera; citizen solo las propias.
   * Una emergencia ajena responde 404 y no 403, para no revelar que el id
   * existe. Un grupo que no sea citizen/dispatcher ya cortó con 403 en el
   * middleware requireCitizenOrDispatcher de la ruta.
   *
   * TODO(#13): cuando exista el grupo `officer`, debe ver solo las
   * emergencias que tiene asignadas (emergency.assignedOfficerId === user.sub).
   * Agregar la regla en canViewEmergency (src/auth/authorize.js) y sumar el
   * grupo al middleware de la ruta; este método no necesita cambios.
   *
   * @param {string} id - UUID de la emergencia (formato inválido → 400)
   * @param {{ sub: string, groups: string[] }} user - identidad autenticada (req.user)
   */
  async getEmergencyDetail(id, user) {
    // Se valida el formato antes de ir a la base: Postgres tiraría un error
    // de sintaxis de uuid (22P02) que terminaría en 500 en vez de 400.
    assertUuid(id);

    const detail = await this.emergencyRepository.findDetailById(id);

    if (!detail || !canViewEmergency(user, detail)) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    return {
      success: true,
      data: {
        ...detail,
        // Placeholders hasta que existan las tareas de observaciones y refuerzos.
        observations: [],
        reinforcementRequests: [],
      },
    };
  }

  async validateEmergency(id, user) {
    assertUuid(id);

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

  /**
   * Devuelve una emergencia DISPATCHED a VALIDATED (devolución para
   * reasignar). Libera al oficial asignado —el repository lo pone
   * `disponible` en la misma transacción al pasar a VALIDATED—, de modo que
   * un despacho equivocado no deje al oficial ocupado sin salida por API.
   * Dispatcher-only. La transición DISPATCHED → VALIDATED ya vive en la
   * máquina de estados del dominio.
   */
  async returnEmergency(id, { reason = null } = {}, user) {
    assertUuid(id);

    const actor = user.sub;
    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, 'VALIDATED');

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'VALIDATED',
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

  async discardEmergency(id, { reason } = {}, user) {
    assertUuid(id);

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
    assertUuid(id);

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

  /**
   * Asigna un oficial disponible: VALIDATED → DISPATCHED.
   * @param {string} id
   * @param {{ officerId?: string }} body
   * @param {{ sub: string }} user
   */
  async assignOfficer(id, { officerId } = {}, user) {
    assertUuid(id);

    const actor = user.sub;
    const normalizedOfficerId = typeof officerId === 'string' ? officerId.trim() : '';

    if (!normalizedOfficerId) {
      throw new ValidationError('officerId is required');
    }

    const emergency = await this.emergencyRepository.findById(id);
    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, 'DISPATCHED');

    const { emergency: updated, officer } = await this.emergencyRepository.assignOfficer(id, {
      officerId: normalizedOfficerId,
      actor,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyStatusUpdatedEvent({
            emergency: savedEmergency,
            history: savedHistory,
            actor,
            reason: `Assigned officer ${normalizedOfficerId}`,
            eventId,
          }),
      },
    });

    return {
      success: true,
      data: {
        ...updated,
        assignedOfficer: officer?.name || null,
      },
    };
  }

  async closeEmergency(id, user) {
    assertUuid(id);

    const actor = user.sub;
    const emergency = await this.emergencyRepository.findById(id);
    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, 'CLOSED');

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'CLOSED',
      actor,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_CERRADA || 'emergencias.cerrada',
        payload: ({ emergency: savedEmergency }, eventId) => buildEmergencyClosedEvent({
          emergency: savedEmergency,
          actor,
          eventId,
        }),
      },
    });

    return { success: true, data: updated };
  }
}

module.exports = { EmergencyController };
