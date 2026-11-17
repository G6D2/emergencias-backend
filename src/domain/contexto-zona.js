// Contexto de zona: una situación de la ciudad que sube un nivel la prioridad
// de despacho de las emergencias cercanas mientras está vigente (ADR "Elevar
// temporalmente la prioridad con contextos de zona"). La zona es un punto con
// un radio en metros, no un barrio.
//
// Acá viven las constantes, la zona y el armado de la ventana de vigencia. La
// persistencia está en repositories/contexto-zona.repository.js y el cálculo
// de la prioridad en la lectura de emergencias (emergency.repository.js).

const CONTEXTO_TIPO = Object.freeze({
  EVENTO_ESPACIO_PUBLICO: 'EVENTO_ESPACIO_PUBLICO',
  ALERTA_CLIMATICA: 'ALERTA_CLIMATICA',
});

const ORIGEN_ESPACIOS = 'espacios';

// Estados de un evento comunitario de Espacios que importan acá. Cancelado es
// definitivo; suspendido es temporal (se puede reanudar). Cualquier otro
// (activo, sin cupos) deja el contexto vigente.
const ESTADOS_CANCELADO = new Set(['CANCELLED', 'CANCELED', 'CANCELADO', 'CANCELADA']);
const ESTADOS_SUSPENDIDO = new Set(['SUSPENDED', 'SUSPENDIDO', 'SUSPENDIDA']);

function estadoNormalizado(estado) {
  return typeof estado === 'string' ? estado.trim().toUpperCase() : '';
}

function esEstadoCancelado(estado) {
  return ESTADOS_CANCELADO.has(estadoNormalizado(estado));
}

function esEstadoSuspendido(estado) {
  return ESTADOS_SUSPENDIDO.has(estadoNormalizado(estado));
}

const DURACION_DEFAULT_HORAS = 6;
const MS_POR_HORA = 60 * 60 * 1000;
// Por debajo de esto un número es un epoch en segundos, no en milisegundos
// (1e11 ms es marzo de 1973; 1e11 s es el año 5138).
const EPOCH_SEGUNDOS_MAX = 1e11;

// Todo contexto nace con vencimiento (regla 6 del ADR): si el evento no trae
// fin, dura CONTEXTO_ZONA_DURACION_DEFAULT_HORAS desde el inicio.
function duracionDefaultMs(env = process.env) {
  const horas = Number(env.CONTEXTO_ZONA_DURACION_DEFAULT_HORAS);
  return (Number.isFinite(horas) && horas > 0 ? horas : DURACION_DEFAULT_HORAS) * MS_POR_HORA;
}

// Radio de la zona. Espacios no lo informa: es un valor fijo del backend,
// configurable con CONTEXTO_ZONA_RADIO_DEFAULT_METROS. Cada contexto guarda el
// radio con el que se registró, así que un cambio vale para los contextos
// nuevos o republicados.
const RADIO_DEFAULT_METROS = 500;

function radioDefaultMetros(env = process.env) {
  const metros = Number(env.CONTEXTO_ZONA_RADIO_DEFAULT_METROS);
  return Number.isFinite(metros) && metros > 0 ? Math.round(metros) : RADIO_DEFAULT_METROS;
}

// Punto del evento: latitud y longitud numéricas y en rango, o null. Un par
// incompleto no ubica nada.
function puntoDelEvento({ latitud, longitud } = {}) {
  const enRango = (valor, maximo) => typeof valor === 'number'
    && Number.isFinite(valor) && Math.abs(valor) <= maximo;
  return enRango(latitud, 90) && enRango(longitud, 180) ? { latitud, longitud } : null;
}

// Acepta lo que puede llegar por el bus: ISO 8601, epoch (segundos o
// milisegundos, también como logical type de Avro) o Date. Lo demás es null.
function parseInstante(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value < EPOCH_SEGUNDOS_MAX ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

function primerInstante(...values) {
  for (const value of values) {
    const instante = parseInstante(value);
    if (instante) return instante;
  }
  return null;
}

/**
 * Ventana de vigencia de un contexto. Sin inicio válido arranca en `ahora`;
 * sin fin válido (o con un fin que no es posterior al inicio) dura el default.
 * @returns {{ vigenteDesde: Date, vigenteHasta: Date }}
 */
function ventanaDeVigencia({ inicio, fin, ahora = new Date(), env = process.env } = {}) {
  const vigenteDesde = parseInstante(inicio) || ahora;
  const finParseado = parseInstante(fin);
  const vigenteHasta = finParseado && finParseado.getTime() > vigenteDesde.getTime()
    ? finParseado
    : new Date(vigenteDesde.getTime() + duracionDefaultMs(env));
  return { vigenteDesde, vigenteHasta };
}

module.exports = {
  CONTEXTO_TIPO,
  ORIGEN_ESPACIOS,
  DURACION_DEFAULT_HORAS,
  RADIO_DEFAULT_METROS,
  radioDefaultMetros,
  puntoDelEvento,
  esEstadoCancelado,
  esEstadoSuspendido,
  duracionDefaultMs,
  parseInstante,
  primerInstante,
  ventanaDeVigencia,
};
