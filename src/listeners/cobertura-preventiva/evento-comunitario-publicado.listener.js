const { EventListener } = require('../event-listener');
const { secureLog } = require('../../security/secure-log');

// EventoComunitarioPublicado (Espacios Publicos): se publico un evento
// comunitario que puede requerir cobertura preventiva.
class EventoComunitarioPublicadoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, { topic: process.env.EDA_TOPIC_EVENTO_PUBLICADO, ...options });
  }

  async handle(event) {
    const metadata = (event && event.metadata) || {};
    const data = (event && event.data) || {};
    secureLog('info', 'EventoComunitarioPublicado recibido', {
      eventId: metadata.eventId,
      nombre: data.nombre,
      capacidad: data.capacidad,
    });
  }
}

module.exports = { EventoComunitarioPublicadoListener };
