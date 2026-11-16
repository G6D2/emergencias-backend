const path = require('path');
const { EventListener } = require('../../event-listener');
const { disparadorDe } = require('../disparador');

// El fqn del tipo es el nombre del tópico (Movilidad no lo versiona).
const DEFAULT_TOPIC = 'com.citypass.movilidad.EmergenciaSolicitada';

// EmergenciaSolicitada (Movilidad): Movilidad evaluó la obstrucción de un
// reclamo de ciclovía y pide que vaya Emergencias.
class EmergenciaSolicitadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_EMERGENCIA_SOLICITADA || DEFAULT_TOPIC,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
    this.disparador = disparadorDe(options);
  }

  buildContext(event) {
    return { ...super.buildContext(event), disparador: this.disparador };
  }
}

module.exports = { EmergenciaSolicitadaListener, DEFAULT_TOPIC };
