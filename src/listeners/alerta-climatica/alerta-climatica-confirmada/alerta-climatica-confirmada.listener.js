const path = require('path');
const { EventListener } = require('../../event-listener');
const { normalizarEnvelope } = require('../envelope');

// Alerta climática confirmada (Espacios Públicos). Crea o actualiza el
// contexto de zona de la alerta. Un cambio de gravedad o de barrios llega como
// otra confirmación con `version` mayor.
//
// El topic real está por confirmar con Espacios: sin
// EDA_TOPIC_ALERTA_CLIMATICA_CONFIRMADA el listener no arranca.
class AlertaClimaticaConfirmadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_ALERTA_CLIMATICA_CONFIRMADA,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }

  buildContext(event) {
    return normalizarEnvelope(event);
  }
}

module.exports = { AlertaClimaticaConfirmadaListener };
