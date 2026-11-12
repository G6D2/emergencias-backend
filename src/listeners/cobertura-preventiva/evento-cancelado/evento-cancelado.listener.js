const path = require('path');
const { EventListener } = require('../../event-listener');
const { normalizarEventoEspacios } = require('../evento-espacios');

// EventoCancelado (Espacios Publicos): se cancelo un evento comunitario o
// actividad publicado previamente. Acepta el id como `eventoId` o
// `actividadId` (ver evento-espacios.js).
class EventoCanceladoListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, { topic: process.env.EDA_TOPIC_EVENTO_CANCELADO, rulesDir: path.join(__dirname, 'rules'), ...options });
  }

  buildContext(event) {
    const context = super.buildContext(event);
    return { ...context, data: normalizarEventoEspacios(context.data) };
  }
}

module.exports = { EventoCanceladoListener };
