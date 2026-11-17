const { AlertaClimaticaConfirmadaListener } = require('./alerta-climatica-confirmada/alerta-climatica-confirmada.listener');
const { AlertaClimaticaFinalizadaListener } = require('./alerta-climatica-finalizada/alerta-climatica-finalizada.listener');

// Alerta climática: Espacios Públicos confirma una alerta por barrios y
// Emergencias sube la prioridad de despacho de las emergencias abiertas de
// esos barrios, para los tipos que afecta el fenómeno, hasta que la alerta se
// finaliza o vence.
module.exports = {
  AlertaClimaticaConfirmadaListener,
  AlertaClimaticaFinalizadaListener,
  listeners: [AlertaClimaticaConfirmadaListener, AlertaClimaticaFinalizadaListener],
};
