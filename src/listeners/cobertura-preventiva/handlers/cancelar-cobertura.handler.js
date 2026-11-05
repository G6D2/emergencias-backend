const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyUpdatedEvent } = require('../../../services/emergency-events');
const { CAUSA_TIPO, EMERGENCY_TYPE } = require('./programar-cobertura.handler');

const CANCELAR_COBERTURA = 'CancelarCobertura';
const ACTOR = 'eda:espacios';
// No se publica el motivo que escribió el organizador: es texto libre.
const REASON = 'Evento comunitario cancelado';
const CANCELLABLE_STATUSES = new Set(['PENDING', 'VALIDATED']);

function emergenciaActualizadaTopic() {
  return process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado';
}

// Cancela la cobertura preventiva de un evento comunitario que Espacios dio
// de baja. Pasa por el repositorio (transición válida, historial y
// EmergenciaActualizada en el outbox), en la transacción del OutcomeFactory.
// Si la cobertura ya avanzó (despachada o más), no se toca: se loguea.
function createCancelarCoberturaHandler({ emergencyRepository, topic = emergenciaActualizadaTopic() }) {
  if (!emergencyRepository) throw new Error('createCancelarCoberturaHandler requiere emergencyRepository');

  return async function cancelarCobertura(client, payload) {
    const { eventoId } = payload || {};
    if (!eventoId) throw new ValidationError('CancelarCobertura requiere eventoId');

    const coberturas = await emergencyRepository.findByCausa(client, {
      causaTipo: CAUSA_TIPO,
      causaId: eventoId,
      emergencyType: EMERGENCY_TYPE,
    });
    if (coberturas.length === 0) {
      secureLog('info', 'EventoCancelado sin cobertura preventiva', { eventoId });
      return { cancelled: 0 };
    }

    let cancelled = 0;
    for (const cobertura of coberturas) {
      if (!CANCELLABLE_STATUSES.has(cobertura.status)) {
        secureLog('warn', 'Cobertura preventiva no cancelada: ya avanzó', {
          eventoId,
          emergencyId: cobertura.id,
          status: cobertura.status,
        });
        continue;
      }
      await emergencyRepository.updateStatus(cobertura.id, {
        client,
        newStatus: 'CANCELLED',
        actor: ACTOR,
        reason: REASON,
        outboxEvent: {
          topic,
          payload: ({ emergency, history }, eventId) => buildEmergencyUpdatedEvent({
            emergency,
            history,
            actor: ACTOR,
            reason: REASON,
            eventId,
          }),
        },
      });
      cancelled += 1;
    }

    secureLog('info', 'Cobertura preventiva cancelada', { eventoId, cancelled });
    return { cancelled };
  };
}

module.exports = { CANCELAR_COBERTURA, createCancelarCoberturaHandler };
