const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyUpdatedEvent } = require('../../../services/emergency-events');
const { CAUSA_TIPO } = require('./crear-intervencion.handler');

const CERRAR_INTERVENCION = 'CerrarIntervencionPorReclamo';
const ACTOR = 'eda:reclamos';
// La máquina de estados solo deja cancelar antes del despacho. Si el agente ya
// salió, la intervención la termina el oficial como cualquier otra.
const CANCELLABLE_STATUSES = new Set(['PENDING', 'VALIDATED']);

function emergenciaActualizadaTopic() {
  return process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado';
}

function createCerrarIntervencionHandler({ emergencyRepository, topic = emergenciaActualizadaTopic() }) {
  if (!emergencyRepository) throw new Error('createCerrarIntervencionHandler requiere emergencyRepository');

  return async function cerrarIntervencion(client, payload) {
    const { reclamoId, estado } = payload || {};
    if (!reclamoId) throw new ValidationError('CerrarIntervencionPorReclamo requiere reclamoId');

    const intervenciones = await emergencyRepository.findByCausa(client, { causaTipo: CAUSA_TIPO, causaId: reclamoId });
    if (intervenciones.length === 0) {
      // Lo normal: casi ningún reclamo es de ciclovía.
      return { cancelled: 0 };
    }

    const reason = `Reclamo ${estado || 'finalizado'}`;
    let cancelled = 0;
    for (const intervencion of intervenciones) {
      if (!CANCELLABLE_STATUSES.has(intervencion.status)) {
        secureLog('info', 'Intervención por reclamo no cancelada: ya avanzó o terminó', {
          reclamoId,
          emergencyId: intervencion.id,
          status: intervencion.status,
        });
        continue;
      }
      await emergencyRepository.updateStatus(intervencion.id, {
        client,
        newStatus: 'CANCELLED',
        actor: ACTOR,
        reason,
        outboxEvent: {
          topic,
          payload: ({ emergency, history }, eventId) => buildEmergencyUpdatedEvent({
            emergency,
            history,
            actor: ACTOR,
            reason,
            eventId,
          }),
        },
      });
      cancelled += 1;
    }

    if (cancelled > 0) {
      secureLog('info', 'Intervención por reclamo cancelada', { reclamoId, estado, cancelled });
    }
    return { cancelled };
  };
}

module.exports = { CERRAR_INTERVENCION, createCerrarIntervencionHandler };
