const { EventListener } = require('./event-listener');
const { BusinessRule } = require('./business-rule');
const { OutcomeFactory } = require('./outcome-factory');
const { PUBLICAR_EVENTO, createPublicarEventoHandler } = require('./handlers/publicar-evento.handler');
const coberturaPreventiva = require('./cobertura-preventiva');

// Paquete de listeners de eventos externos.
//
// Cada caso de negocio es un subpaquete (carpeta) con sus listeners concretos
// (subclases de EventListener) y un index.js que los exporta en `listeners`.
// Para sumar un caso nuevo: crear la carpeta y agregarla a PACKAGES.
const PACKAGES = [coberturaPreventiva];

// Factory con los handlers de todos los casos de negocio. Para sumar un type
// nuevo: crear su handler en handlers/ y registrarlo aca.
function createOutcomeFactory({ pool, emergencyRepository }) {
  return new OutcomeFactory(pool).register(PUBLICAR_EVENTO, createPublicarEventoHandler(emergencyRepository));
}

function createListeners(kafka, { factory } = {}) {
  return PACKAGES.flatMap((pkg) => pkg.listeners.map((Listener) => new Listener(kafka, { factory })));
}

module.exports = {
  EventListener,
  BusinessRule,
  OutcomeFactory,
  coberturaPreventiva,
  createListeners,
  createOutcomeFactory,
};
