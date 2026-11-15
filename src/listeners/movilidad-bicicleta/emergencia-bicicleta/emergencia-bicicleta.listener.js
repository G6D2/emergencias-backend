const path = require('path');
const { EventListener } = require('../../event-listener');

const DEFAULT_TOPIC = 'com.citypass.movilidad.EmergenciaBicicleta';

class EmergenciaBicicletaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_EMERGENCIA_BICICLETA || DEFAULT_TOPIC,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { EmergenciaBicicletaListener, DEFAULT_TOPIC };
