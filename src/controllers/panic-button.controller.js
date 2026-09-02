const { v4: uuidv4 } = require('uuid');
const { NotFoundError, ValidationError } = require('../errors/app-errors');

class PanicButtonController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
  }

  async triggerPanicButton(payload) {
    if (!payload.userId || !payload.location) {
      throw new ValidationError('Missing required fields: userId, location');
    }

    const emergencyId = uuidv4();

    const emergency = await this.emergencyRepository.create({
      id: emergencyId,
      userId: payload.userId,
      latitude: payload.location.latitude,
      longitude: payload.location.longitude,
      description: payload.description || 'Botón de pánico activado',
      severity: payload.severity || 'critical',
      status: 'PENDING',
    });

    await this.kafkaService.publishEvent(
      process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico',
      emergency
    );

    return {
      success: true,
      emergencyId,
      message: 'Botón de pánico activado',
      data: emergency,
    };
  }

  async getPanicButtonEvent(emergencyId) {
    const emergency = await this.emergencyRepository.findById(emergencyId);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${emergencyId} not found`);
    }

    return {
      success: true,
      data: emergency,
    };
  }
}

module.exports = { PanicButtonController };
