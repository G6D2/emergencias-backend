const { BusinessRule } = require('../../../business-rule');

const UMBRAL_DEFAULT = 500;

// Programa cobertura preventiva cuando un evento comunitario de Espacios
// supera el umbral de capacidad (asistentes esperados).
//
// Umbral: UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA (env), default 500.
// Payload de Espacios (EventoComunitarioPublicado): eventoId, titulo,
// latitud, longitud, direccion, capacidad (o cupoMaximo), estado y
// correlationId. Un evento ya cancelado no programa nada.
class ProgramarCoberturaPreventivaRule extends BusinessRule {
  get umbral() {
    const v = Number(process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA || UMBRAL_DEFAULT);
    return Number.isFinite(v) && v > 0 ? v : UMBRAL_DEFAULT;
  }

  capacidad(data) {
    return Number(data.capacidad ?? data.cupoMaximo);
  }

  appliesTo(context) {
    const data = context.data || {};
    if (typeof data.eventoId !== 'string' || !data.eventoId) return false;
    if (data.estado === 'CANCELLED') return false;
    const capacidad = this.capacidad(data);
    return Number.isFinite(capacidad) && capacidad >= this.umbral;
  }

  apply(context) {
    const { data = {} } = context;
    return {
      type: 'ProgramarCobertura',
      payload: {
        eventoId: data.eventoId,
        titulo: typeof data.titulo === 'string' && data.titulo ? data.titulo : 'Evento comunitario',
        latitud: typeof data.latitud === 'number' ? data.latitud : null,
        longitud: typeof data.longitud === 'number' ? data.longitud : null,
        direccion: typeof data.direccion === 'string' ? data.direccion : null,
        capacidad: this.capacidad(data),
        correlationId: typeof data.correlationId === 'string' ? data.correlationId : null,
      },
    };
  }
}

module.exports = { ProgramarCoberturaPreventivaRule };
