const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');

const PUBLICAR_CONFIRMACION_CLIMA = 'PublicarConfirmacionClima';
const CONFIRMACION_CLIMA_EVENT_TYPE = 'CriticidadClimaticaConfirmada';
const CONFIRMACION_CLIMA_TOPIC_DEFAULT = `com.citypass.emergencias.${CONFIRMACION_CLIMA_EVENT_TYPE}`;

function confirmacionClimaTopic(env = process.env) {
  return env.TOPIC_CONFIRMACION_CLIMA || CONFIRMACION_CLIMA_TOPIC_DEFAULT;
}

// Encola en el outbox la confirmación de una alerta climática recibida. El
// gateway publica solo `data` en com.citypass.emergencias.CriticidadClimaticaConfirmada.
// Corre en la transacción del OutcomeFactory: si falla, no queda ni el
// contexto ni la confirmación, y el evento se reintenta.
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
  createPublicarConfirmacionClimaHandler,
};
