const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { PUBLICAR_CONFIRMACION_CLIMA } = require('../../handlers/confirmacion-clima.handler');

function textoNoVacio(valor) {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

// Emergencias confirma por el EDA que recibió la alerta climática:
// com.citypass.emergencias.CriticidadClimaticaConfirmada con alertaId,
// NivelCriticidad y fenomeno (mismo contrato que publica Residuos). Sale por el
// outbox, en la misma transacción que el contexto de zona.
//
// Se confirma toda alerta recibida con esos tres datos, eleve o no la
// prioridad. Los campos del schema son string obligatorios: si falta alguno no
// hay confirmación (la regla 01 decide aparte si hay contexto). Se reenvía tal
// cual lo que mandó Espacios. Un reenvío del mismo evento no duplica: lo frena
// el dedup por eventId del OutcomeFactory.
class ConfirmarAlertaClimaticaRule extends BusinessRule {
  appliesTo(context) {
    const data = context.data || {};
    return isUuid(data.alertaId)
      && Boolean(textoNoVacio(data.nivelCriticidad))
      && Boolean(textoNoVacio(data.fenomeno));
  }

  apply(context) {
    const { data = {}, metadata = {} } = context;
    return {
      type: PUBLICAR_CONFIRMACION_CLIMA,
      payload: {
        alertaId: data.alertaId,
        NivelCriticidad: textoNoVacio(data.nivelCriticidad),
        fenomeno: textoNoVacio(data.fenomeno),
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
      },
    };
  }
}

module.exports = { ConfirmarAlertaClimaticaRule };
