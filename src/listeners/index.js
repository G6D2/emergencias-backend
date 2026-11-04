const { EventListener } = require('./event-listener');
const { BusinessRule } = require('./business-rule');
const { OutcomeFactory } = require('./outcome-factory');
const coberturaPreventiva = require('./cobertura-preventiva');

// Paquete de listeners de eventos externos.
//
// Cada caso de negocio es un subpaquete (carpeta) con sus listeners concretos
// (subclases de EventListener) y un index.js que los exporta en `listeners`.
// Para sumar un caso nuevo: crear la carpeta y agregarla a PACKAGES.
const PACKAGES = [coberturaPreventiva];

// options.factory (OutcomeFactory): si se pasa, cada listener lo recibe y
// ejecuta los outcomes en una transaccion atomica con dedup opcional.
function createListeners(kafka, options = {}) {
  return PACKAGES.flatMap((pkg) => pkg.listeners.map((Listener) => new Listener(kafka, options)));
}

module.exports = {
  EventListener,
  BusinessRule,
  OutcomeFactory,
  coberturaPreventiva,
  createListeners,
};
