const { NotFoundError, ValidationError, ConflictError } = require('../errors/app-errors');
const {
  canAdvanceEmergencyStatus,
  canCancelEmergency,
  canViewEmergency,
  userHasGroup,
} = require('../auth/authorize');
const { GROUPS } = require('../auth/groups');
// Las transiciones válidas viven en el dominio (src/domain/emergency-status.js);
// una transición inválida lanza ConflictError (409).
const { assertTransition, isValidStatus, EMERGENCY_STATUSES } = require('../domain/emergency-status');
const { buildEmergencyUpdatedEvent } = require('../services/emergency-events');
const { assertEmergencyType } = require('../domain/emergency-type');
const { isValidSeverity } = require('../domain/severity');
const { scrubFreeText } = require('../security/pii-scrub');
const { secureLog } = require('../security/secure-log');
const { assertUuid } = require('../utils/uuid');

// El motivo de cancelar, devolver o descartar queda en el historial y viaja
// en el outbox como `resolucion`: se sanea igual que description (PII
// redactada y recorte a 280 caracteres). Un valor que no sea string es 400.
const MAX_REASON_LENGTH = 280;

function normalizeReason(reason) {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') {
    throw new ValidationError('reason must be a string');
  }
  return scrubFreeText(reason, { maxLength: MAX_REASON_LENGTH }) || null;
}

// Fecha ISO 8601 para from/to: 2026-11-05, 2026-11-05T10:00 o con segundos,
// fracción y offset (Z, -03:00). Date.parse solo no alcanza: acepta "1" o
// "Nov 5", y corre el 30 de febrero al 2 de marzo, que Postgres rechaza (500).
const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDateFilter(name, value) {
  if (value === undefined || value === '') return undefined;
  const match = typeof value === 'string' ? ISO_DATE_RE.exec(value) : null;
  const day = match && new Date(`${match[1]}T00:00:00Z`);
  if (!match || Number.isNaN(Date.parse(value)) || day.toISOString().slice(0, 10) !== match[1]) {
    throw new ValidationError(`${name} must be an ISO 8601 date`);
  }
  return value;
}

// incident/effectivePriority son información operativa (a qué incidente fue
// agrupada la emergencia, con qué prioridad): un citizen no la ve ni en el
// listado ni en el detalle, aunque sean sus propias emergencias.
// eslint-disable-next-line no-unused-vars
function withoutOperationalFields({ incident, effectivePriority, ...rest }) {
  return rest;
}

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
    // El repository calcula incident/effectivePriority igual para todos (un
    // solo JOIN); para un citizen se recortan acá (withoutOperationalFields).
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
    // Un status desconocido daba 200 con la lista vacía; un from/to que no es
    // fecha llegaba a Postgres y volvía 500. Los dos son 400.
    if (!statuses.every(isValidStatus)) {
      throw new ValidationError(`status must be a comma-separated list of: ${EMERGENCY_STATUSES.join(', ')}`);
    }
    const from = parseDateFilter('from', query.from);
    const to = parseDateFilter('to', query.to);
    const sortBy = query.sortBy === 'priority' ? 'priority' : 'createdAt';
    const order = query.order === 'asc' ? 'asc' : 'desc';
    const { emergencies, total } = await this.emergencyRepository.findPage({
      userId,
      statuses,
      severity: query.severity || query.priority,
      from,
      to,
      assignedOfficerId: query.assignedOfficerId,
      // Acepta canónico o alias del front (medical → MEDICA); inválido → 400.
      // `type` se mantiene por compatibilidad con clientes existentes.
      emergencyType: assertEmergencyType(query.emergencyType || query.type),
      page,
      limit,
      sortBy,
      order,
    });

    const data = isDispatcher ? emergencies : emergencies.map(withoutOperationalFields);

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
   * Con `audit: true` (GET /api/emergencies/:id) la lectura ya autorizada
   * queda en emergency_access_audit. GET /api/panic-button/:id delega acá sin
   * esa opción porque registra su propio acceso.
   *
   * @param {string} id - UUID de la emergencia (formato inválido → 400)
   * @param {{ sub: string, groups: string[] }} user - identidad autenticada (req.user)
   * @param {{ audit?: boolean }} [options]
   */
  async getEmergencyDetail(id, user, { audit = false } = {}) {
    // Se valida el formato antes de ir a la base: Postgres tiraría un error
    // de sintaxis de uuid (22P02) que terminaría en 500 en vez de 400.
    assertUuid(id);

    const detail = await this.emergencyRepository.findDetailById(id);

    if (!detail || !canViewEmergency(user, detail)) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    if (audit) {
      await this.recordReadAccess(id, user);
    }

    const visibleDetail = userHasGroup(user, GROUPS.DISPATCHER) ? detail : withoutOperationalFields(detail);

    return {
      success: true,
      data: {
        ...visibleDetail,
        // Placeholders hasta que existan las tareas de observaciones y refuerzos.
        observations: [],
        reinforcementRequests: [],
      },
    };
  }

  // Mismo mecanismo que GET /api/panic-button/:id: la lectura ya autorizada
  // no falla porque no se pudo auditar; se deja constancia del problema.
  async recordReadAccess(emergencyId, user) {
    try {
      await this.emergencyRepository.recordAccess({
        emergencyId,
        actorSub: user.sub,
        action: 'emergency:read',
      });
    } catch (error) {
      secureLog('error', 'Failed to record emergency access audit', {
        emergencyId,
        actorSub: user.sub,
        message: error.message,
      });
    }
  }

  /**
   * Transición compartida a VALIDATED. validateEmergency solo sale de
   * PENDING y returnEmergency solo de DISPATCHED (devolución para reasignar).
   * El dominio permite las dos transiciones, así que sin `fromStatus` un
   * /validate sobre una DISPATCHED funcionaba como una devolución. El estado
   * de origen se vuelve a comprobar con la fila bloqueada (requireStatus en
   * el repository). Al pasar a VALIDATED el repository libera al oficial
   * asignado y deja assigned_officer_id en NULL, en la misma transacción.
   */
  async transitionToValidated(id, { fromStatus, actor, reason = null }) {
    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, 'VALIDATED');
    if (emergency.status !== fromStatus) {
      throw new ConflictError(`Emergency ${id} is ${emergency.status}, expected ${fromStatus}`);
    }

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'VALIDATED',
      requireStatus: fromStatus,
      actor,
      reason,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyUpdatedEvent({
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

  async validateEmergency(id, user) {
    assertUuid(id);
    return this.transitionToValidated(id, { fromStatus: 'PENDING', actor: user.sub });
  }

  /**
   * Devuelve una emergencia DISPATCHED a VALIDATED (devolución para
   * reasignar). Libera al oficial asignado, de modo que un despacho
   * equivocado no lo deje ocupado sin salida por API. Dispatcher-only.
   */
  async returnEmergency(id, { reason = null } = {}, user) {
    assertUuid(id);
    return this.transitionToValidated(id, {
      fromStatus: 'DISPATCHED',
      actor: user.sub,
      reason: normalizeReason(reason),
    });
  }

  async discardEmergency(id, { reason } = {}, user) {
    assertUuid(id);

    const actor = user.sub;
    const normalizedReason = normalizeReason(reason);

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
          buildEmergencyUpdatedEvent({
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
  async cancelEmergency(id, { reason: rawReason = null } = {}, user) {
    assertUuid(id);

    const actor = user.sub;
    const reason = normalizeReason(rawReason);
    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    // Emergencia ajena: 404 (no 403) para no revelar que el id existe, misma
    // regla que GET /api/emergencies/:id. Un no-citizen ya cortó con 403 en la
    // ruta (requireCitizen), así que acá solo llega un citizen que no es dueño.
    if (!canCancelEmergency(user, emergency)) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, 'CANCELLED');

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'CANCELLED',
      actor,
      reason,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyUpdatedEvent({
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
          buildEmergencyUpdatedEvent({
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

    // El contrato cerrado (issue #48 comment 2026-11-02) elimina EmergenciaCerrada
    // como evento aparte: el cierre viaja como EmergenciaActualizada con estadoNuevo=CERRADA.
    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'CLOSED',
      actor,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyUpdatedEvent({
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
   * Avance del estado operativo por el oficial asignado (HU-08, issue #21):
   * DISPATCHED → EN_ROUTE → ON_SCENE → RESOLVED. Las tres acciones comparten
   * este método; solo cambia el estado destino.
   *
   * - Una emergencia inexistente, sin oficial o asignada a OTRO oficial
   *   responde 404 (no 403), igual que cancelar una emergencia ajena: no se
   *   revela que el id existe.
   * - Saltear un estado, o repetir uno ya aplicado, responde 409 (el dominio
   *   decide en assertTransition).
   * - El oficial se vuelve a comprobar bajo el lock de la fila
   *   (requireAssignedOfficerId), por si el dispatcher devolvió y reasignó
   *   entre la lectura y el UPDATE.
   */
  async advanceOperationalStatus(id, newStatus, user) {
    assertUuid(id);

    const actor = user.sub;
    const emergency = await this.emergencyRepository.findById(id);
    if (!emergency || !canAdvanceEmergencyStatus(user, emergency)) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }

    assertTransition(emergency.status, newStatus);

    const { emergency: updated } = await this.emergencyRepository.updateStatus(id, {
      newStatus,
      actor,
      requireAssignedOfficerId: actor,
      outboxEvent: {
        topic: process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
        payload: ({ emergency: savedEmergency, history: savedHistory }, eventId) =>
          buildEmergencyUpdatedEvent({
            emergency: savedEmergency,
            history: savedHistory,
            actor,
            reason: null,
            eventId,
          }),
      },
    });

    return { success: true, data: updated };
  }

  async markEnRoute(id, user) {
    return this.advanceOperationalStatus(id, 'EN_ROUTE', user);
  }

  async markOnScene(id, user) {
    return this.advanceOperationalStatus(id, 'ON_SCENE', user);
  }

  async markResolved(id, user) {
    return this.advanceOperationalStatus(id, 'RESOLVED', user);
  }
}

module.exports = { EmergencyController };
