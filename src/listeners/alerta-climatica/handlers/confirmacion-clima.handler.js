const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');

const PUBLICAR_CONFIRMACION_CLIMA = 'PublicarConfirmacionClima';
const CONFIRMACION_CLIMA_EVENT_TYPE = 'CriticidadClimaticaConfirmada';
const CONFIRMACION_CLIMA_TOPIC_DEFAULT = `com.citypass.emergencias.${CONFIRMACION_CLIMA_EVENT_TYPE}`;

function confirmacionClimaTopic(env = process.env) {
  return env.TOPIC_CONFIRMACION_CLIMA || CONFIRMACION_CLIMA_TOPIC_DEFAULT;
}

// La confirmación se encola solo con CONFIRMACION_CLIMA_ENABLED=true. Queda
// apagada por default, como el evento de vínculo: si el tipo no está en el
// catálogo del gateway, cada fila del outbox quedaría FAILED (404).
function confirmacionClimaHabilitada(env = process.env) {
  return env.CONFIRMACION_CLIMA_ENABLED === 'true';
}

// Encola en el outbox la confirmación de que Emergencias recibió una alerta
// climática de Espacios. El gateway publica solo `data` en
// com.citypass.emergencias.CriticidadClimaticaConfirmada, con alertaId,
// NivelCriticidad y fenomeno (mismo contrato que Residuos). Corre en la
// transacción del OutcomeFactory, junto con la emergencia y los contextos de
// la alerta: si algo falla, no queda nada y el evento se reintenta.
function createPublicarConfirmacionClimaHandler({ emergencyRepository }) {
  if (!emergencyRepository) throw new Error('createPublicarConfirmacionClimaHandler requiere emergencyRepository');

  return async function publicarConfirmacionClima(client, payload) {
    const { alertaId, NivelCriticidad, fenomeno, causationId } = payload || {};
    if (!alertaId || !NivelCriticidad || !fenomeno) {
      throw new ValidationError('PublicarConfirmacionClima requiere alertaId, NivelCriticidad y fenomeno');
    }

    await emergencyRepository.insertOutboxEvent(client, {
      topic: confirmacionClimaTopic(),
      payload: {
        type: CONFIRMACION_CLIMA_EVENT_TYPE,
        correlationId: alertaId,
        causationId: causationId || null,
        data: { alertaId, NivelCriticidad, fenomeno },
      },
    });
    secureLog('info', 'Confirmación de alerta climática encolada', { alertaId, NivelCriticidad, fenomeno });
    return { applied: true };
  };
}

module.exports = {
  PUBLICAR_CONFIRMACION_CLIMA,
  CONFIRMACION_CLIMA_EVENT_TYPE,
  confirmacionClimaTopic,
  confirmacionClimaHabilitada,
  createPublicarConfirmacionClimaHandler,
};
