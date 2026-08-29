const { NotFoundError, ConflictError } = require('../errors/app-errors');

// Estados desde los que un ciudadano puede cancelar su propia emergency.
// DISCARDED lo decide el Dispatcher; no pasa por este endpoint.
const CANCELABLE_STATUSES = new Set(['CREATED']);

class EmergencyController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
  }

  async cancelEmergency(id, { actor = null, reason = null } = {}) {
    const emergency = await this.emergencyRepository.findById(id);

    if (!emergency) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
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
