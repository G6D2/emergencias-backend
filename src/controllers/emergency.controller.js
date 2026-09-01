const { NotFoundError, ConflictError } = require('../errors/app-errors');

// Estados desde los que un ciudadano puede cancelar su propia emergencia.
// DESCARTADA es una decisión del Dispatcher, no pasa por este endpoint.
const CANCELABLE_STATUSES = new Set(['PENDIENTE']);

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

    const { emergency: updated, historial } = await this.emergencyRepository.updateStatus(id, {
      newStatus: 'CANCELADA',
      actor,
      reason,
    });

    await this.kafkaService.publishEvent(
      process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado',
      {
        type: 'EmergenciaEstadoActualizado',
        emergenciaId: updated.id,
        estadoAnterior: historial.estadoAnterior,
        estadoNuevo: historial.estadoNuevo,
        actor,
        motivo: reason,
        timestamp: new Date().toISOString(),
      }
    );

    return { success: true, data: updated };
  }
}

module.exports = { EmergencyController };
