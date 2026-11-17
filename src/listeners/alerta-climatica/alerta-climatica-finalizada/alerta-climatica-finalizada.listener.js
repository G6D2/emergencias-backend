const path = require('path');
const { EventListener } = require('../../event-listener');
const { normalizarEnvelope } = require('../envelope');

// Alerta climática finalizada (Espacios Públicos): el administrador cerró la
// alerta. Da de baja su contexto de zona.
//
// Contrato de Espacios: trae `data.alertaId`, `finalizadaEn` y `actorSub`.
// Topic: el FQN real por defecto; EDA_TOPIC_ALERTA_CLIMATICA_FINALIZADA lo pisa.
const TOPIC_DEFAULT = 'com.citypass.espacios.CriticidadClimaticaFinalizada';
class AlertaClimaticaFinalizadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_ALERTA_CLIMATICA_FINALIZADA || TOPIC_DEFAULT,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }

  buildContext(event) {
    return normalizarEnvelope(event);
  }
}

module.exports = { AlertaClimaticaFinalizadaListener };
