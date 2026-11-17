const path = require('node:path');
const { EventListener } = require('../../event-listener');

// CriticidadClimaticaConfirmada (Espacios Públicos): un administrador
// confirmó una alerta climática.
//
// Opt-in: sin EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA no se consume (el
// EventConsumer lo saltea con un warn y /health lo muestra disabled). Hay un
// solo consumer para todos los listeners, así que suscribirse a un topic que
// no existe frenaría a los demás: el nombre real
// (com.citypass.espacios.CriticidadClimaticaConfirmada, o con sufijo .vN si
// Espacios evolucionó el schema) se confirma en el catálogo del gateway antes
// de cargarlo.
class CriticidadClimaticaConfirmadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { CriticidadClimaticaConfirmadaListener };
