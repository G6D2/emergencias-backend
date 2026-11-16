const { BusinessRule } = require('../../../business-rule');
const { parseInstante } = require('../../../../domain/contexto-zona');
const {
  NIVELES_CON_EMERGENCIA,
  alertaIdValido,
  barriosDeLaAlerta,
  nivelNormalizado,
  ubicacionesDeLaAlerta,
} = require('../../../../domain/alerta-climatica');

// Con nivel ALTA o CRITICA, la alerta crea una emergencia PREVENTIVA
// (causaTipo EVENTO_CLIMATICO, causaId alertaId). Va antes que el alta de
// los contextos, aunque las PREVENTIVA no se vinculan a ningún contexto.
//
// Una alerta que ya venció cuando llega (el listener lee el tópico desde el
// principio, o el servicio estuvo dormido) no crea nada: no hay a qué
// desplegar. Sin vigenciaHasta se asume vigente.
class CrearEmergenciaClimaticaRule extends BusinessRule {
  appliesTo({ data = {} }) {
    if (!alertaIdValido(data.alertaId)) return false;
    if (!NIVELES_CON_EMERGENCIA.has(nivelNormalizado(data.nivelCriticidad))) return false;
    const hasta = parseInstante(data.vigenciaHasta);
    return !hasta || hasta.getTime() > Date.now();
  }

  apply({ data = {} }) {
    const [primera] = ubicacionesDeLaAlerta(data);
    return {
      type: 'CrearEmergenciaClimatica',
      payload: {
        alertaId: data.alertaId,
        nivel: nivelNormalizado(data.nivelCriticidad),
        fenomeno: typeof data.fenomeno === 'string' ? data.fenomeno : null,
        latitud: primera ? primera.punto.latitud : null,
        longitud: primera ? primera.punto.longitud : null,
        barrios: barriosDeLaAlerta(data),
      },
    };
  }
}

module.exports = { CrearEmergenciaClimaticaRule };
