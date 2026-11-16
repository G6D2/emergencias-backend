const path = require('path');
const { EventListener } = require('../../event-listener');

const DEFAULT_TOPIC = 'com.citypass.espacios.ActividadCreada.v3';

// ActividadCreada (Espacios Publicos): se creo una actividad que puede requerir
// cobertura preventiva. Espacios la publica en el topic versionado
// com.citypass.espacios.ActividadCreada.v3. Como el resto de los listeners, el
// topic tiene default en el codigo y EDA_TOPIC_ACTIVIDAD_CREADA lo pisa (si
// Espacios sube a otra version, alcanza con cambiar la variable).
class ActividadCreadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_ACTIVIDAD_CREADA || DEFAULT_TOPIC,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { ActividadCreadaListener, DEFAULT_TOPIC };
