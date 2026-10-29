const { EventoComunitarioPublicadoListener } = require('./evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { EventoCanceladoListener } = require('./evento-cancelado/evento-cancelado.listener');

// Cobertura preventiva: Espacios Publicos publica o cancela eventos
// comunitarios que pueden requerir presencia preventiva de Emergencias.
module.exports = {
  EventoComunitarioPublicadoListener,
  EventoCanceladoListener,
  listeners: [EventoComunitarioPublicadoListener, EventoCanceladoListener],
};
