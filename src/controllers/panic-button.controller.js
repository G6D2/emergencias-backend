const { v4: uuidv4 } = require('uuid');

class PanicButtonController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
  }

  async triggerPanicButton(payload) {
    try {
      const emergencyId = uuidv4();

      // Validate required fields
      if (!payload.userId || !payload.location) {
        throw new Error('Missing required fields: userId, location');
      }

      const emergency = await this.emergencyRepository.create({
        id: emergencyId,
        userId: payload.userId,
        latitude: payload.location.latitude,
        longitude: payload.location.longitude,
        description: payload.description || 'Botón de pánico activado',
        severity: payload.severity || 'critical',
        status: 'PENDIENTE',
      });

      // Publish to Kafka
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
    } catch (error) {
      console.error('Error triggering panic button:', error);
      throw error;
    }
  }

  async getPanicButtonEvent(emergencyId) {
    try {
      const emergency = await this.emergencyRepository.findById(emergencyId);

      if (!emergency) {
        throw new Error(`Emergency with ID ${emergencyId} not found`);
      }

      return {
        success: true,
        data: emergency,
      };
    } catch (error) {
      console.error('Error getting panic button event:', error);
      throw error;
    }
  }
}

module.exports = { PanicButtonController };
