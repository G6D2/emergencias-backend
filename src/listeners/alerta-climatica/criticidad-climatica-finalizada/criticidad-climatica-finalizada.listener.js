const path = require('node:path');
const { EventListener } = require('../../event-listener');

// CriticidadClimaticaFinalizada (Espacios Públicos): la alerta venció o se
// cerró a mano. Trae el mismo alertaId que la confirmación.
//
// Opt-in, igual que la confirmación: sin
// EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA no se consume. Conviene cargar
// las dos variables juntas: sin la finalización, los contextos vencen solos
// con vigenciaHasta, pero la PREVENTIVA no se cancela.
class CriticidadClimaticaFinalizadaListener extends EventListener {
  constructor(kafka, options = {}) {
    super(kafka, {
      topic: process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA,
      rulesDir: path.join(__dirname, 'rules'),
      ...options,
    });
  }
}

module.exports = { CriticidadClimaticaFinalizadaListener };
