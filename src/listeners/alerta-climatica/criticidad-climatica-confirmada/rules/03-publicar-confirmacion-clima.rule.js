const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { alertaIdValido } = require('../../../../domain/alerta-climatica');
const {
  PUBLICAR_CONFIRMACION_CLIMA,
  confirmacionClimaHabilitada,
} = require('../../handlers/confirmacion-clima.handler');

function textoNoVacio(valor) {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

// Emergencias confirma por el EDA que recibió la alerta climática:
// com.citypass.emergencias.CriticidadClimaticaConfirmada con alertaId,
// NivelCriticidad y fenomeno (mismo contrato que publica Residuos). Sale por el
// outbox, en la misma transacción que la emergencia y los contextos de la
// alerta.
//
// Se confirma toda alerta recibida con esos tres datos, de cualquier nivel
// (también BAJA y MEDIA, que no generan nada más). Los campos del schema son
// string obligatorios: si falta alguno no hay confirmación. Se reenvía tal
// cual lo que mandó Espacios. Un reenvío del mismo evento no duplica: lo frena
// el dedup por eventId del OutcomeFactory.
//
// Solo con CONFIRMACION_CLIMA_ENABLED=true (ver confirmacion-clima.handler).
class PublicarConfirmacionClimaRule extends BusinessRule {
  appliesTo({ data = {} } = {}) {
    return confirmacionClimaHabilitada()
      && alertaIdValido(data.alertaId)
      && Boolean(textoNoVacio(data.nivelCriticidad))
      && Boolean(textoNoVacio(data.fenomeno));
  }

  apply({ data = {}, metadata = {} } = {}) {
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

module.exports = { PublicarConfirmacionClimaRule };
