const { EventListener } = require('./event-listener');
const { EventConsumer } = require('./event-consumer');
const { BusinessRule } = require('./business-rule');
const { OutcomeFactory } = require('./outcome-factory');
const { superviseListener } = require('./listener-supervisor');
const coberturaPreventiva = require('./cobertura-preventiva');
const reclamoIntervencion = require('./reclamo-intervencion');
const movilidadBicicleta = require('./movilidad-bicicleta');
const alertaClimatica = require('./alerta-climatica');

// Paquete de listeners de eventos externos.
//
// Cada caso de negocio es un subpaquete (carpeta) con sus listeners concretos
// (subclases de EventListener) y un index.js que los exporta en `listeners`.
// Para sumar un caso nuevo: crear la carpeta y agregarla a PACKAGES.
const PACKAGES = [coberturaPreventiva, reclamoIntervencion, movilidadBicicleta, alertaClimatica];

// options.factory (OutcomeFactory): si se pasa, cada listener lo recibe y
// ejecuta los outcomes en una transaccion atomica con dedup opcional.
function createListeners(kafka, options = {}) {
  return PACKAGES.flatMap((pkg) => pkg.listeners.map((Listener) => new Listener(kafka, options)));
}

module.exports = {
  EventListener,
  EventConsumer,
  BusinessRule,
  OutcomeFactory,
  coberturaPreventiva,
  reclamoIntervencion,
  movilidadBicicleta,
  alertaClimatica,
  createListeners,
  superviseListener,
};
