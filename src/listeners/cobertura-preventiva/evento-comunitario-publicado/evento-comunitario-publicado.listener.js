const path = require('path');
const { EventListener } = require('../../event-listener');

// EventoComunitarioPublicado (Espacios Publicos): se publico un evento
// comunitario que puede requerir cobertura preventiva.
class EventoComunitarioPublicadoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, { topic: process.env.EDA_TOPIC_EVENTO_PUBLICADO, rulesDir: path.join(__dirname, 'rules'), ...options });
  }
}

module.exports = { EventoComunitarioPublicadoListener };
