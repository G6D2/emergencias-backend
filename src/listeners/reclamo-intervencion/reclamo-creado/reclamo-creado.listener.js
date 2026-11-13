const path = require('path');
const { EventListener } = require('../../event-listener');
const { disparadorDe } = require('../disparador');

// Reclamos versiona el tipo: la versión vigente (3) va en su propio tópico.
// La versión 1 del nombre la registró otro equipo y no trae objetoAfectado.
const DEFAULT_TOPIC = 'com.citypass.reclamos.ReclamoCreado.v3';

// ReclamoCreado (Reclamos): un vecino cargó un reclamo. Solo crea la
// intervención si RECLAMO_INTERVENCION_DISPARADOR es reclamo o ambos; con el
// default (movilidad) se consume y no hace nada.
class ReclamoCreadoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_RECLAMO_CREADO || DEFAULT_TOPIC,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
    this.disparador = disparadorDe(options);
  }

  buildContext(event) {
    return { ...super.buildContext(event), disparador: this.disparador };
  }
}

module.exports = { ReclamoCreadoListener, DEFAULT_TOPIC };
