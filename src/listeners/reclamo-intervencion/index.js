const { EmergenciaSolicitadaListener } = require('./emergencia-solicitada/emergencia-solicitada.listener');
const { ReclamoCreadoListener } = require('./reclamo-creado/reclamo-creado.listener');
const { ReclamoActualizadoListener } = require('./reclamo-actualizado/reclamo-actualizado.listener');

// Reclamo que desencadena una intervención: un vecino reclama por un auto en
// la ciclovía, Movilidad evalúa la obstrucción y pide la emergencia
// (EmergenciaSolicitada), y Emergencias manda un agente. Cuando el reclamo se
// cierra (lo resuelve Espacios con IntervencionFinalizada), la intervención
// que todavía no salió se cancela.
//
// RECLAMO_INTERVENCION_DISPARADOR (ver disparador.js) decide quién crea la
// intervención: Movilidad (default), el ReclamoCreado directo, o cualquiera
// de los dos.
module.exports = {
  EmergenciaSolicitadaListener,
  ReclamoCreadoListener,
  ReclamoActualizadoListener,
  listeners: [EmergenciaSolicitadaListener, ReclamoCreadoListener, ReclamoActualizadoListener],
};
