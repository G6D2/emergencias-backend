const path = require('path');
const { EventListener } = require('../../event-listener');
const { DEFAULT_TOPIC_CONFIRMADA } = require('../../../domain/alerta-climatica');

// CriticidadClimaticaConfirmada (Espacios Públicos): un administrador
// confirmó una alerta climática.
class CriticidadClimaticaConfirmadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA || DEFAULT_TOPIC_CONFIRMADA,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { CriticidadClimaticaConfirmadaListener, DEFAULT_TOPIC: DEFAULT_TOPIC_CONFIRMADA };
