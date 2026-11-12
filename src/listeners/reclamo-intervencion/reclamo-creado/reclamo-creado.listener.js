const path = require('path');
const { EventListener } = require('../../event-listener');

// Reclamos versiona el tipo: la versión vigente (3) va en su propio tópico.
// La versión 1 del nombre la registró otro equipo y no trae objetoAfectado.
const DEFAULT_TOPIC = 'com.citypass.reclamos.ReclamoCreado.v3';

// ReclamoCreado (Reclamos): un vecino cargó un reclamo.
class ReclamoCreadoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_RECLAMO_CREADO || DEFAULT_TOPIC,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { ReclamoCreadoListener, DEFAULT_TOPIC };
