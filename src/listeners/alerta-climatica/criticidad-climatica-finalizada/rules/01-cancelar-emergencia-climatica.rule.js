const { BusinessRule } = require('../../../business-rule');
const { alertaIdValido } = require('../../../../domain/alerta-climatica');

// La alerta terminó: si su emergencia climática sigue sin despachar, se cancela.
class CancelarEmergenciaClimaticaRule extends BusinessRule {
  appliesTo({ data = {} }) {
    return alertaIdValido(data.alertaId);
  }

  apply({ data = {} }) {
    return { type: 'CancelarEmergenciaClimatica', payload: { alertaId: data.alertaId } };
  }
}

module.exports = { CancelarEmergenciaClimaticaRule };
