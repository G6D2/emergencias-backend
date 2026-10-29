const { EventListener } = require('./event-listener');
const { BusinessRule } = require('./business-rule');
const coberturaPreventiva = require('./cobertura-preventiva');

// Paquete de listeners de eventos externos.
//
// Cada caso de negocio es un subpaquete (carpeta) con sus listeners concretos
// (subclases de EventListener) y un index.js que los exporta en `listeners`.
// Para sumar un caso nuevo: crear la carpeta y agregarla a PACKAGES.
const PACKAGES = [coberturaPreventiva];

function createListeners(kafka) {
  return PACKAGES.flatMap((pkg) => pkg.listeners.map((Listener) => new Listener(kafka)));
}

module.exports = {
  EventListener,
  BusinessRule,
  coberturaPreventiva,
  createListeners,
};
