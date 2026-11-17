const path = require('path');
const { EventListener } = require('../../event-listener');
const { normalizarEnvelope } = require('../envelope');

// Alerta climática confirmada (Espacios Públicos). Crea o actualiza el
// contexto de zona de la alerta. Un cambio de gravedad o de barrios llega como
// otra confirmación con `version` mayor.
//
// Topic: el FQN real de Espacios por defecto; EDA_TOPIC_ALERTA_CLIMATICA_CONFIRMADA
// lo pisa.
const TOPIC_DEFAULT = 'com.citypass.espacios.CriticidadClimaticaConfirmada';
class AlertaClimaticaConfirmadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_ALERTA_CLIMATICA_CONFIRMADA || TOPIC_DEFAULT,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }

  buildContext(event) {
    return normalizarEnvelope(event);
  }
}

module.exports = { AlertaClimaticaConfirmadaListener };
