const { v4: uuidv4 } = require('uuid');
const { KafkaService } = require('../services/kafka.service');

class PanicButtonController {
  constructor() {
    this.kafkaService = new KafkaService();
    // In-memory storage for demo (no persistence yet)
    this.emergencies = new Map();
  }

  async triggerPanicButton(payload) {
    try {
      const emergencyId = uuidv4();
      const timestamp = new Date().toISOString();

      // Validate required fields
      if (!payload.userId || !payload.location) {
        throw new Error('Missing required fields: userId, location');
      }

      const emergencyEvent = {
        id: emergencyId,
        userId: payload.userId,
        location: payload.location,
        description: payload.description || 'Botón de pánico activado',
        severity: payload.severity || 'critical',
        timestamp,
        status: 'creada',
      };

      // Store in memory
      this.emergencies.set(emergencyId, emergencyEvent);

      // Publish to Kafka
      await this.kafkaService.publishEvent(
        process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico',
        emergencyEvent
      );

      return {
        success: true,
        emergencyId,
        message: 'Botón de pánico activado',
        data: emergencyEvent,
      };
    } catch (error) {
      console.error('Error triggering panic button:', error);
      throw error;
    }
  }

  async getPanicButtonEvent(emergencyId) {
    try {
      const emergency = this.emergencies.get(emergencyId);

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
