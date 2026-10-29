const { EventListener } = require('./event-listener');
const { secureLog } = require('../security/secure-log');

// EventoCancelado (Espacios Publicos): se cancelo un evento comunitario
// publicado previamente.
class EventoCanceladoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, { topic: process.env.EDA_TOPIC_EVENTO_CANCELADO, ...options });
  }

  async handle(event) {
    const metadata = (event && event.metadata) || {};
    secureLog('info', 'EventoCancelado recibido', {
      eventId: metadata.eventId,
      causationId: metadata.causationId,
    });
  }
}

module.exports = { EventoCanceladoListener };
