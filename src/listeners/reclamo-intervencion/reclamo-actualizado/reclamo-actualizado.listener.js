const path = require('path');
const { EventListener } = require('../../event-listener');

const DEFAULT_TOPIC = 'com.citypass.reclamos.ReclamoActualizado';

// ReclamoActualizado (Reclamos): el reclamo cambió de estado.
class ReclamoActualizadoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_RECLAMO_ACTUALIZADO || DEFAULT_TOPIC,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { ReclamoActualizadoListener, DEFAULT_TOPIC };
