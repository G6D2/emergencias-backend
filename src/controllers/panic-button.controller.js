const { v4: uuidv4 } = require('uuid');
const { NotFoundError, ValidationError, ForbiddenError } = require('../errors/app-errors');
const { canViewEmergency } = require('../auth/authorize');
const { secureLog } = require('../security/secure-log');
const { buildEmergencyCreatedEvent } = require('../services/emergency-events');

class PanicButtonController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
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

    const emergencyId = uuidv4();

    const emergency = await this.emergencyRepository.create({
      id: emergencyId,
      userId: user.sub,
      latitude,
      longitude,
      description: payload.description || 'Botón de pánico activado',
      severity: payload.severity || 'critical',
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

  async getPanicButtonEvent(emergencyId, user) {
    const emergency = await this.emergencyRepository.findById(emergencyId);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${emergencyId} not found`);
    }

    if (!canViewEmergency(user, emergency)) {
      throw new ForbiddenError('You cannot access this emergency');
    }

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

    return {
      success: true,
      data: emergency,
    };
  }
}

module.exports = { PanicButtonController };
