const { EventoComunitarioPublicadoListener } = require('./evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { EventoCanceladoListener } = require('./evento-cancelado/evento-cancelado.listener');
const { ActividadCreadaListener } = require('./actividad-creada/actividad-creada.listener');

// Cobertura preventiva: Espacios Publicos publica o cancela eventos
// comunitarios que pueden requerir presencia preventiva de Emergencias.
module.exports = {
  EventoComunitarioPublicadoListener,
  EventoCanceladoListener,
  ActividadCreadaListener,
  listeners: [EventoComunitarioPublicadoListener, EventoCanceladoListener, ActividadCreadaListener],
};
