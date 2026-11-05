const { v4: uuidv4 } = require('uuid');
const { ValidationError } = require('../errors/app-errors');
const { secureLog } = require('../security/secure-log');
const { scrubFreeText } = require('../security/pii-scrub');
const { buildEmergencyCreatedEvent } = require('../services/emergency-events');
const { assertEmergencyType } = require('../domain/emergency-type');
const { severityForType } = require('../domain/severity');
const { EmergencyController } = require('./emergency.controller');

const MIN_LATITUDE = -90;
const MAX_LATITUDE = 90;
const MIN_LONGITUDE = -180;
const MAX_LONGITUDE = 180;
const MAX_ADDRESS_LENGTH = 200;

/**
 * Sanitiza la dirección legible opcional del body: nunca lanza (un dato mal
 * formado se ignora, no corta el reporte con 400). Reglas: debe ser string,
 * se le quitan saltos de línea (reemplazados por espacio), se recorta a los
 * extremos y se trunca a MAX_ADDRESS_LENGTH caracteres. Vacía o no-string → null.
 */
function normalizeAddress(rawAddress) {
  if (typeof rawAddress !== 'string') return null;

  const withoutLineBreaks = rawAddress.replace(/[\r\n]+/g, ' ');
  const trimmed = withoutLineBreaks.trim();

  return trimmed ? trimmed.slice(0, MAX_ADDRESS_LENGTH) : null;
}

class PanicButtonController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
    // GET /api/panic-button/:id delega en el mismo método de detalle que usa
    // GET /api/emergencies/:id: misma regla de acceso, mismo 404 unificado
    // para una emergencia ajena (ver EmergencyController#getEmergencyDetail).
    this.emergencyController = new EmergencyController(kafkaService, emergencyRepository);
  }

  /**
   * @param {object} payload - body del request (sin userId: viene del JWT)
   * @param {{ sub: string }} user - identidad autenticada (req.user)
   */
  async triggerPanicButton(payload, user) {
    if (!payload.location) {
      throw new ValidationError('Missing required fields: location');
    }

    const { latitude, longitude } = payload.location;
    if (typeof latitude !== 'number' || typeof longitude !== 'number'
      || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      throw new ValidationError('location.latitude and location.longitude must be numbers');
    }

    if (latitude < MIN_LATITUDE || latitude > MAX_LATITUDE) {
      throw new ValidationError(`location.latitude must be between ${MIN_LATITUDE} and ${MAX_LATITUDE}`);
    }
    if (longitude < MIN_LONGITUDE || longitude > MAX_LONGITUDE) {
      throw new ValidationError(`location.longitude must be between ${MIN_LONGITUDE} and ${MAX_LONGITUDE}`);
    }

    // Catálogo cerrado (tarea #44): un valor inválido corta con 400. Si el
    // cliente no manda tipo, es el botón SOS: PANICO.
    const emergencyType = assertEmergencyType(payload.emergencyType) || 'PANICO';
    if (emergencyType === 'PREVENTIVA') {
      throw new ValidationError('emergencyType PREVENTIVA la crea el sistema, no se puede reportar');
    }

    // Decisión de producto: la severidad no la elige quien reporta. Se
    // deriva del emergencyType (src/domain/severity.js); un `severity` en el
    // body se ignora (no 400, para no romper al front hasta que se actualice).
    if (payload.severity !== undefined) {
      secureLog('debug', 'severity del body ignorada: se deriva del emergencyType', {
        emergencyType,
        suppliedSeverity: payload.severity,
      });
    }
    const severity = severityForType(emergencyType);

    const emergencyId = uuidv4();
    // Dirección legible opcional (para que el dispatcher no dependa de
    // geocodificación inversa en vivo): nunca rompe el alta, se sanea o se ignora.
    const address = normalizeAddress(payload.address);

    const emergency = await this.emergencyRepository.create({
      id: emergencyId,
      // Tarea #58 (ADR-001): correlationId = emergencyId al crear; con él se
      // traza creación → priorización → despacho en los eventos.
      correlationId: emergencyId,
      userId: user.sub,
      latitude,
      longitude,
      address,
      description: scrubFreeText(payload.description, {
        fallback: 'Botón de pánico activado',
      }),
      severity,
      emergencyType,
      status: 'PENDING',
      outboxEvent: {
        topic: process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico',
        payload: (savedEmergency, eventId) => buildEmergencyCreatedEvent(savedEmergency, eventId),
      },
    });

    return {
      success: true,
      emergencyId,
      message: 'Botón de pánico activado',
      data: emergency,
    };
  }

  /**
   * Se mantiene por compatibilidad con clientes existentes (el detalle
   * completo vive en GET /api/emergencies/:id). Reglas de acceso y el 404
   * unificado (una emergencia ajena no revela su existencia) son las mismas
   * que en el detalle: delega ahí y solo agrega la auditoría de acceso propia
   * de este endpoint.
   */
  async getPanicButtonEvent(emergencyId, user) {
    const detail = await this.emergencyController.getEmergencyDetail(emergencyId, user);

    if (typeof this.emergencyRepository.recordAccess === 'function') {
      try {
        await this.emergencyRepository.recordAccess({
          emergencyId,
          actorSub: user.sub,
          action: 'emergency:read',
        });
      } catch (error) {
        // La lectura ya autorizada no falla por auditoría; se registra el problema.
        secureLog('error', 'Failed to record emergency access audit', {
          emergencyId,
          actorSub: user.sub,
          message: error.message,
        });
      }
    }

    return detail;
  }
}

module.exports = { PanicButtonController };
