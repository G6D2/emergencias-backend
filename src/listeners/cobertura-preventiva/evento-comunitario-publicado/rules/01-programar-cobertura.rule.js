const { BusinessRule } = require('../../../business-rule');

const UMBRAL_DEFAULT = 500;

// Programa cobertura preventiva cuando un evento comunitario de Espacios
// supera el umbral de capacidad (asistentes esperados).
//
// Umbral: UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA (env), default 500.
// Si lat/lng faltan, el handler persiste igual pero con requires_manual_validation=true.
class ProgramarCoberturaPreventivaRule extends BusinessRule {
  get umbral() {
    const v = Number(process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA || UMBRAL_DEFAULT);
    return Number.isFinite(v) && v > 0 ? v : UMBRAL_DEFAULT;
  }

  appliesTo(context) {
    const capacidad = context.data?.capacidad;
    return Number.isFinite(Number(capacidad)) && Number(capacidad) >= this.umbral;
  }

  apply(context) {
    const { data = {}, metadata = {} } = context;
    return {
      type: 'ProgramarCobertura',
      payload: {
        nombre: data.nombre || 'Evento comunitario',
        latitud: typeof data.latitud === 'number' ? data.latitud : null,
        longitud: typeof data.longitud === 'number' ? data.longitud : null,
        capacidad: Number(data.capacidad),
        causationEventId: metadata.eventId,
      },
    };
  }
}

module.exports = { ProgramarCoberturaPreventivaRule };
