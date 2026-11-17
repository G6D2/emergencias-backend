const path = require('path');
const { EventListener } = require('../../event-listener');

// ReservaCreada (Espacios Publicos): alta de una reserva de espacio o de una
// inscripcion a un evento. Una reserva grande de un espacio puede requerir
// cobertura preventiva (causaTipo RESERVA).
//
// Opt-in: sin EDA_TOPIC_RESERVA_CREADA no se consume (el EventConsumer lo
// saltea con un warn). Hay un solo consumer para todos los listeners, asi que
// suscribirse a un topic que no existe frenaria a los demas: el nombre real
// (com.citypass.espacios.ReservaCreada, o con sufijo .vN si Espacios evoluciono
// el schema) se confirma en el catalogo del gateway antes de cargarlo.
class ReservaCreadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_RESERVA_CREADA,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { ReservaCreadaListener };
