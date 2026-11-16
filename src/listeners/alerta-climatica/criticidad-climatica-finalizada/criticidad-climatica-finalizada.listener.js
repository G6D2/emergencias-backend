const path = require('path');
const { EventListener } = require('../../event-listener');
const { DEFAULT_TOPIC_FINALIZADA } = require('../../../domain/alerta-climatica');

// CriticidadClimaticaFinalizada (Espacios Públicos): la alerta venció o se
// cerró a mano. Trae el mismo alertaId que la confirmación.
class CriticidadClimaticaFinalizadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA || DEFAULT_TOPIC_FINALIZADA,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { CriticidadClimaticaFinalizadaListener, DEFAULT_TOPIC: DEFAULT_TOPIC_FINALIZADA };
