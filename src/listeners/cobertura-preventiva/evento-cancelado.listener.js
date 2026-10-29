const { EventListener } = require('../event-listener');

// EventoCancelado (Espacios Publicos): se cancelo un evento comunitario
// publicado previamente.
class EventoCanceladoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, { topic: process.env.EDA_TOPIC_EVENTO_CANCELADO, ...options });
  }

  rules() {
    return [];
  }
}

module.exports = { EventoCanceladoListener };
