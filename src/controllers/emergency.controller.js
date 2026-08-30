const { NotFoundError, ConflictError, ForbiddenError } = require('../errors/app-errors');
const { canCancelEmergency, userHasGroup } = require('../auth/authorize');
const { GROUPS } = require('../auth/groups');

// Estados desde los que un citizen puede cancelar su propia emergency.
// DISCARDED lo decide el Dispatcher; no pasa por este endpoint.
const CANCELABLE_STATUSES = new Set(['CREATED']);

class EmergencyController {
  constructor(kafkaService, emergencyRepository) {
    this.kafkaService = kafkaService;
    this.emergencyRepository = emergencyRepository;
  }

  /**
   * Lista emergencias visibles para el usuario autenticado.
   * dispatcher → todas; citizen → solo las propias.
   * @param {{ sub: string, groups?: string[] }} user
   */
  async listEmergencies(user) {
    const all = await this.emergencyRepository.findAll();
    const data = userHasGroup(user, GROUPS.DISPATCHER)
      ? all
      : all.filter((emergency) => emergency.userId === user.sub);

    return { success: true, data };
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
