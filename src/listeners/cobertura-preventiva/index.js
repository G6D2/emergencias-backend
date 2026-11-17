const { EventoComunitarioPublicadoListener } = require('./evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { EventoCanceladoListener } = require('./evento-cancelado/evento-cancelado.listener');
const { ActividadCreadaListener } = require('./actividad-creada/actividad-creada.listener');
const { ReservaCreadaListener } = require('./reserva-creada/reserva-creada.listener');

// Cobertura preventiva: Espacios Publicos publica o cancela eventos
// comunitarios, o confirma reservas grandes de espacios, que pueden requerir
// presencia preventiva de Emergencias.
module.exports = {
  EventoComunitarioPublicadoListener,
  EventoCanceladoListener,
  ActividadCreadaListener,
  ReservaCreadaListener,
  listeners: [EventoComunitarioPublicadoListener, EventoCanceladoListener, ActividadCreadaListener, ReservaCreadaListener],
};
