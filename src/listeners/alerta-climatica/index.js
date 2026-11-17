const { CriticidadClimaticaConfirmadaListener } = require('./criticidad-climatica-confirmada/criticidad-climatica-confirmada.listener');
const { CriticidadClimaticaFinalizadaListener } = require('./criticidad-climatica-finalizada/criticidad-climatica-finalizada.listener');

// Alerta climática: Espacios Públicos confirma o finaliza la criticidad
// climática de una zona (issues #80 y #88 del board).
module.exports = {
  CriticidadClimaticaConfirmadaListener,
  CriticidadClimaticaFinalizadaListener,
  listeners: [CriticidadClimaticaConfirmadaListener, CriticidadClimaticaFinalizadaListener],
};
