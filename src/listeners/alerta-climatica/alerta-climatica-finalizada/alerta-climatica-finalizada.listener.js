const path = require('path');
const { EventListener } = require('../../event-listener');
const { normalizarEnvelope } = require('../envelope');

// Alerta climática finalizada (Espacios Públicos): el administrador cerró la
// alerta. Da de baja su contexto de zona.
//
// El nombre del evento, su topic y su payload están por confirmar con
// Espacios: se asume que trae `data.alertaId`. Sin
// EDA_TOPIC_ALERTA_CLIMATICA_FINALIZADA el listener no arranca.
class AlertaClimaticaFinalizadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_ALERTA_CLIMATICA_FINALIZADA,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }

  buildContext(event) {
    return normalizarEnvelope(event);
  }
}

module.exports = { AlertaClimaticaFinalizadaListener };
