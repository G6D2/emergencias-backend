const { ReclamoCreadoListener } = require('./reclamo-creado/reclamo-creado.listener');
const { ReclamoActualizadoListener } = require('./reclamo-actualizado/reclamo-actualizado.listener');

// Reclamo que desencadena una intervención: Reclamos publica un reclamo de
// tránsito sobre una ciclovía y Emergencias manda un agente. Cuando el reclamo
// se cierra (lo resuelve Espacios con IntervencionFinalizada), la intervención
// que todavía no salió se cancela.
module.exports = {
  ReclamoCreadoListener,
  ReclamoActualizadoListener,
  listeners: [ReclamoCreadoListener, ReclamoActualizadoListener],
};
