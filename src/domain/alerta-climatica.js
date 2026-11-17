// Alerta climática de Espacios como contexto de zona (ADR "Elevar la prioridad
// con contextos de zona por radio o por barrio"). La zona son los barrios de
// la alerta. Mientras está vigente, sube un nivel la prioridad de despacho de
// las emergencias abiertas de esos barrios, solo para los tipos que el
// fenómeno afecta y solo si la gravedad llega al umbral.
//
// Puro, sin I/O: lo usan las reglas de listeners/alerta-climatica/.

const { parseInstante } = require('./contexto-zona');

// De menor a mayor: el orden se usa para comparar contra el umbral.
const GRAVEDADES = Object.freeze(['LEVE', 'MEDIA', 'ALTA', 'EXTREMA']);
const GRAVEDAD_MINIMA_DEFAULT = 'ALTA';

// Qué tipos de emergencia eleva cada fenómeno. Un tipo sube solo si el
// fenómeno aumenta el riesgo de ese tipo de emergencia o el daño que causa.
// "Todo se demora con lluvia" afecta a todos por igual y no reordena la cola.
//
// Nunca se elevan por clima: DISTURBIO_EVENTO_MASIVO (el clima no lo agrava),
// OTRO (no sabemos qué es), PANICO (ya nace critical) y PREVENTIVA (es
// cobertura, no un llamado).
//
// Solo los 9 fenómenos del catálogo de Espacios (guía "CityPass Eventos
// climáticos", 13/11/2026). Espacios define el catálogo; qué tipos sube cada
// uno lo decide Emergencias. Sumar un fenómeno es sumar una entrada.
const TIPOS_POR_FENOMENO = Object.freeze({
  TORMENTA_FUERTE: Object.freeze(['INFRAESTRUCTURA', 'TRANSITO']), // lluvia y viento, sin rayos
  LLUVIA_INTENSA: Object.freeze(['INFRAESTRUCTURA', 'TRANSITO']), // anegamientos, calzada resbaladiza
  VIENTO_FUERTE: Object.freeze(['INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO']), // propaga el fuego, árboles caídos
  OLA_DE_CALOR: Object.freeze(['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA']), // golpes de calor, cortes de luz
  OLA_DE_FRIO: Object.freeze(['MEDICA']), // hipotermia
  GRANIZO: Object.freeze(['INFRAESTRUCTURA', 'TRANSITO']), // techos, vehículos, visibilidad
  TORMENTA_ELECTRICA: Object.freeze(['INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO']), // rayos, cables caídos
  HURACAN: Object.freeze(['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO']), // heridos, estructuras, vías
  NIEVE: Object.freeze(['MEDICA', 'INFRAESTRUCTURA', 'TRANSITO']), // hipotermia, estructuras, calzada
});

// Un fenómeno fuera del catálogo no sube nada: el contexto se registra (sale
// en el banner) y la regla deja un warn en el log.
const TIPOS_FENOMENO_DESCONOCIDO = Object.freeze([]);

const MARGEN_HORAS_DEFAULT = 3;
const TOPE_HORAS_DEFAULT = 24;
const MS_POR_HORA = 60 * 60 * 1000;

function normalizarCodigo(valor) {
  return typeof valor === 'string' && valor.trim() ? valor.trim().toUpperCase() : null;
}

/** Gravedad canónica (LEVE, MEDIA, ALTA, EXTREMA) o null si no es ninguna. */
function normalizarGravedad(valor) {
  const gravedad = normalizarCodigo(valor);
  return GRAVEDADES.includes(gravedad) ? gravedad : null;
}

// Criticidad de Espacios (nivelCriticidad, contrato real) → gravedad
// canónica. El umbral (ALTA) no cambia: suben ALTA y CRITICA.
const CRITICIDAD_A_GRAVEDAD = Object.freeze({
  BAJA: 'LEVE',
  MEDIA: 'MEDIA',
  ALTA: 'ALTA',
  CRITICA: 'EXTREMA',
});

/**
 * Gravedad canónica del evento: `gravedad` (formato del ejemplo) o
 * `nivelCriticidad` (contrato real de Espacios). Si vienen los dos, gana
 * `gravedad`. null si ninguno es válido.
 */
function gravedadDesdeEvento(data = {}) {
  return normalizarGravedad(data.gravedad)
    || CRITICIDAD_A_GRAVEDAD[normalizarCodigo(data.nivelCriticidad)]
    || null;
}

/** Fenómeno en mayúsculas sin espacios alrededor, o null. No valida el catálogo. */
function normalizarFenomeno(valor) {
  return normalizarCodigo(valor);
}

function esFenomenoConocido(fenomeno) {
  const codigo = normalizarFenomeno(fenomeno);
  return codigo !== null && Object.prototype.hasOwnProperty.call(TIPOS_POR_FENOMENO, codigo);
}

// Umbral configurable con CONTEXTO_CLIMA_GRAVEDAD_MINIMA. Un valor inválido
// usa el default.
function gravedadMinima(env = process.env) {
  return normalizarGravedad(env.CONTEXTO_CLIMA_GRAVEDAD_MINIMA) || GRAVEDAD_MINIMA_DEFAULT;
}

/**
 * Tipos de emergencia que eleva la alerta. Una gravedad por debajo del umbral,
 * nula o desconocida devuelve []: el contexto existe y se avisa en el banner,
 * pero no sube nada.
 * @returns {string[]}
 */
function tiposAfectados({ fenomeno, gravedad, env = process.env } = {}) {
  const canonica = normalizarGravedad(gravedad);
  if (!canonica || GRAVEDADES.indexOf(canonica) < GRAVEDADES.indexOf(gravedadMinima(env))) {
    return [];
  }
  const tipos = esFenomenoConocido(fenomeno)
    ? TIPOS_POR_FENOMENO[normalizarFenomeno(fenomeno)]
    : TIPOS_FENOMENO_DESCONOCIDO;
  return [...tipos];
}

function horas(env, nombre, porDefecto) {
  const valor = Number(env[nombre]);
  return Number.isFinite(valor) && valor > 0 ? valor : porDefecto;
}

/**
 * Ventana de vigencia de la alerta. Lo normal es que termine antes, con el
 * evento de finalización: el fin calculado acá es un tope de seguridad, por
 * si ese evento no llega (todo contexto nace con vencimiento).
 *
 * - vigenteDesde: fechaInicio, o `ahora` si no viene o es inválida.
 * - vigenteHasta: fechaFinEstimada + CONTEXTO_CLIMA_MARGEN_HORAS (3). Si no
 *   viene, es inválida o no es posterior al inicio: vigenteDesde +
 *   CONTEXTO_CLIMA_TOPE_HORAS (24).
 * @returns {{ vigenteDesde: Date, vigenteHasta: Date }}
 */
function ventanaAlertaClimatica({
  fechaInicio, fechaFinEstimada, ahora = new Date(), env = process.env,
} = {}) {
  const vigenteDesde = parseInstante(fechaInicio) || ahora;
  const finEstimado = parseInstante(fechaFinEstimada);
  const vigenteHasta = finEstimado && finEstimado.getTime() > vigenteDesde.getTime()
    ? new Date(finEstimado.getTime() + horas(env, 'CONTEXTO_CLIMA_MARGEN_HORAS', MARGEN_HORAS_DEFAULT) * MS_POR_HORA)
    : new Date(vigenteDesde.getTime() + horas(env, 'CONTEXTO_CLIMA_TOPE_HORAS', TOPE_HORAS_DEFAULT) * MS_POR_HORA);
  return { vigenteDesde, vigenteHasta };
}

module.exports = {
  GRAVEDADES,
  GRAVEDAD_MINIMA_DEFAULT,
  TIPOS_POR_FENOMENO,
  TIPOS_FENOMENO_DESCONOCIDO,
  MARGEN_HORAS_DEFAULT,
  TOPE_HORAS_DEFAULT,
  CRITICIDAD_A_GRAVEDAD,
  normalizarGravedad,
  gravedadDesdeEvento,
  normalizarFenomeno,
  esFenomenoConocido,
  gravedadMinima,
  tiposAfectados,
  ventanaAlertaClimatica,
};
