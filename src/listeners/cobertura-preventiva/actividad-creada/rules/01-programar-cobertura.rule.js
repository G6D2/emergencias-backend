const { BusinessRule } = require('../../../business-rule');

const UMBRAL_DEFAULT = 1000;
const ESTADOS_SIN_COBERTURA = new Set(['CANCELADA', 'CANCELLED']);

// Programa cobertura preventiva cuando una actividad de Espacios llega al
// umbral de personas (acordado en el squad: 1.000 o mas).
//
// Umbral: UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA (env), default 1000. Es la
// misma variable que lee la regla de EventoComunitarioPublicado; alli el
// default historico es 500, asi que en produccion conviene fijarla en 1000
// para que las dos reglas coincidan.
//
// Payload de Espacios (ActividadCreada.v2): actividadId (= eventoId),
// titulo, capacidad (entero, no hay asistentes), ubicacion { lat, lng },
// direccion, estado (PROGRAMADA), correlationId (act-<id>),
// fechaHoraInicio / fechaHoraFinalizacion (epoch millis).
//
// Emite el mismo ProgramarCobertura que la otra regla (eventoId = actividadId),
// asi que el handler y su dedup por causa son los mismos: una sola cobertura
// por actividad aunque lleguen los dos eventos.
class ProgramarCoberturaActividadRule extends BusinessRule {
  get umbral() {
    const v = Number(process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA || UMBRAL_DEFAULT);
    return Number.isFinite(v) && v > 0 ? v : UMBRAL_DEFAULT;
  }

  capacidad(data) {
    return Number(data.capacidad);
  }

  appliesTo(context) {
    const data = context.data || {};
    if (typeof data.actividadId !== 'string' || !data.actividadId) return false;
    if (ESTADOS_SIN_COBERTURA.has(data.estado)) return false;
    const capacidad = this.capacidad(data);
    return Number.isFinite(capacidad) && capacidad >= this.umbral;
  }

  apply(context) {
    const { data = {} } = context;
    const ubicacion = data.ubicacion && typeof data.ubicacion === 'object' ? data.ubicacion : {};
    return {
      type: 'ProgramarCobertura',
      payload: {
        eventoId: data.actividadId,
        titulo: typeof data.titulo === 'string' && data.titulo ? data.titulo : 'Actividad',
        latitud: typeof ubicacion.lat === 'number' ? ubicacion.lat : null,
        longitud: typeof ubicacion.lng === 'number' ? ubicacion.lng : null,
        direccion: typeof data.direccion === 'string' ? data.direccion : null,
        barrio: null,
        capacidad: this.capacidad(data),
        correlationId: typeof data.correlationId === 'string' ? data.correlationId : null,
      },
    };
  }
}

module.exports = { ProgramarCoberturaActividadRule };
