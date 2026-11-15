const path = require('path');
const { EventListener } = require('../../event-listener');

// ActividadCreada (Espacios Publicos): se creo una actividad que puede requerir
// cobertura preventiva. Espacios la publica en el topic versionado
// com.citypass.espacios.ActividadCreada.v3 (EDA_TOPIC_ACTIVIDAD_CREADA).
class ActividadCreadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, { topic: process.env.EDA_TOPIC_ACTIVIDAD_CREADA, rulesDir: path.join(__dirname, 'rules'), ...options });
  }
}

module.exports = { ActividadCreadaListener };
