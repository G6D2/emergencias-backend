const { EventListener } = require('./event-listener');
const { EventoComunitarioPublicadoListener } = require('./evento-comunitario-publicado.listener');
const { EventoCanceladoListener } = require('./evento-cancelado.listener');

// Para suscribirse a un evento nuevo: crear una subclase de EventListener y
// agregarla aca.
function createListeners(kafka) {
  return [
    new EventoComunitarioPublicadoListener(kafka),
    new EventoCanceladoListener(kafka),
  ];
}

module.exports = {
  EventListener,
  EventoComunitarioPublicadoListener,
  EventoCanceladoListener,
  createListeners,
};
