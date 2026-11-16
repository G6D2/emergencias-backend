const { BusinessRule } = require('../../../business-rule');

const UMBRAL_DEFAULT = 500;
const ESTADOS_SIN_COBERTURA = new Set(['CANCELADA', 'CANCELLED']);

// Epoch millis de una fecha del evento. Acepta number, bigint, Date, string
// numerico o ISO; devuelve NaN si no hay un valor interpretable.
function aMillis(valor) {
  if (valor === null || valor === undefined || valor === '') return NaN;
  if (typeof valor === 'bigint') return Number(valor);
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string') {
    const n = Number(valor);
    return Number.isFinite(n) ? n : Date.parse(valor);
  }
  return NaN;
}

// Programa cobertura preventiva cuando una actividad de Espacios llega al
// umbral de personas.
//
// Umbral: UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA (env), default 500: el mismo
// que la regla de EventoComunitarioPublicado, asi que las dos entradas usan un
// solo criterio sin cargar nada en produccion. Es un criterio de seguridad de
// Emergencias (cubrir antes); otros modulos del caso usan 1.000 para clasificar
// la causa, y toda actividad de 1.000 o mas tambien se cubre.
//
// No programa cobertura para (1) actividades que ya terminaron
// (fechaHoraFinalizacion < ahora): al arrancar sin offset el listener relee el
// topico entero y crearia una PREVENTIVA por cada actividad vieja; ni
// (2) reservas de vecinos (organizadorTipo CIUDADANO): su baja llega por
// ActividadModificada, que no consumimos. Sin fecha de fin o sin organizadorTipo
// la actividad se cubre.
//
// Payload de Espacios (ActividadCreada.v3): actividadId (= eventoId),
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
    if (data.organizadorTipo === 'CIUDADANO') return false;
    const fin = aMillis(data.fechaHoraFinalizacion);
    if (Number.isFinite(fin) && fin < Date.now()) return false;
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
