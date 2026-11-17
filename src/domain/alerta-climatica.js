// Alerta climática de Espacios (issues #80 y #88 del board; ADR "Responder a
// las alertas climáticas de Espacios").
//
// Espacios consulta Open-Meteo, un administrador confirma la criticidad y
// publica `CriticidadClimaticaConfirmada`; al vencer o cerrarse a mano publica
// `CriticidadClimaticaFinalizada` con el mismo `alertaId`. El payload
// confirmado trae `alertaId`, `nivelCriticidad`, `fenomeno`,
// `ubicaciones: [{ latitud, longitud }]`, `barrios`, `vigenciaDesde` y
// `vigenciaHasta` (epoch ms). Una alerta confirmada no cambia de cobertura:
// si cambia, Espacios genera otra alerta.
//
// Política por nivel (punto 2 del ADR). Solo ALTA y CRITICA son accionables,
// igual que en Espacios:
// - un contexto de zona ALERTA_CLIMATICA por cada punto de `ubicaciones`,
//   con el radio del nivel (CRITICA 1000 m, ALTA 500 m, configurables);
// - una emergencia PREVENTIVA por `alertaId` (causaTipo EVENTO_CLIMATICO),
//   con la severidad del nivel.
// BAJA y MEDIA no generan nada.

const { CONTEXTO_TIPO, ORIGEN_ESPACIOS, puntoDelEvento } = require('./contexto-zona');

const CAUSA_TIPO_CLIMA = 'EVENTO_CLIMATICO';

const NIVELES = Object.freeze(['BAJA', 'MEDIA', 'ALTA', 'CRITICA']);

// Severidad de la PREVENTIVA y radio de cada contexto, por nivel accionable.
// Cada contexto guarda el radio con el que se registró: un cambio de la
// variable vale para las alertas que se confirmen después.
const POLITICA_POR_NIVEL = Object.freeze({
  ALTA: Object.freeze({
    severity: 'high',
    radioDefaultMetros: 500,
    radioEnv: 'CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS',
  }),
  CRITICA: Object.freeze({
    severity: 'critical',
    radioDefaultMetros: 1000,
    radioEnv: 'CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS',
  }),
});

const RADIO_CLIMA_DEFAULT_METROS = Object.freeze({
  ALTA: POLITICA_POR_NIVEL.ALTA.radioDefaultMetros,
  CRITICA: POLITICA_POR_NIVEL.CRITICA.radioDefaultMetros,
});

function politicaDelNivel(nivel) {
  return Object.prototype.hasOwnProperty.call(POLITICA_POR_NIVEL, nivel) ? POLITICA_POR_NIVEL[nivel] : null;
}

// ALTA y CRITICA (ya normalizados). BAJA, MEDIA o cualquier otro valor, no.
function esNivelAccionable(nivel) {
  return politicaDelNivel(nivel) !== null;
}

function severityDelNivel(nivel) {
  const politica = politicaDelNivel(nivel);
  return politica ? politica.severity : null;
}

// Radio en metros de los contextos de un nivel accionable, o null para el
// resto. Un valor de entorno inválido (no numérico o <= 0) deja el default.
function radioClimaMetros(nivel, env = process.env) {
  const politica = politicaDelNivel(nivel);
  if (!politica) return null;
  const metros = Number(env[politica.radioEnv]);
  return Number.isFinite(metros) && metros > 0 ? Math.round(metros) : politica.radioDefaultMetros;
}

// Nivel en mayúsculas sin tilde (CRÍTICA → CRITICA), o null si no es del catálogo.
function nivelNormalizado(nivel) {
  if (typeof nivel !== 'string') return null;
  const limpio = nivel.trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return NIVELES.includes(limpio) ? limpio : null;
}

function alertaIdValido(alertaId) {
  return typeof alertaId === 'string' && alertaId.trim().length > 0 && alertaId === alertaId.trim();
}

// TORMENTA_FUERTE → "tormenta fuerte", para las descripciones.
function fenomenoLegible(fenomeno) {
  return typeof fenomeno === 'string' && fenomeno.trim()
    ? fenomeno.trim().replace(/_/g, ' ').toLowerCase()
    : 'evento climático';
}

// Puntos con coordenadas numéricas y en rango, en el orden en que llegaron.
// Un punto inválido se descarta sin correr el índice de los demás: el índice
// es parte de la referencia del contexto y tiene que ser estable entre
// reentregas del mismo evento.
function ubicacionesDeLaAlerta(data = {}) {
  const ubicaciones = Array.isArray(data.ubicaciones) ? data.ubicaciones : [];
  return ubicaciones
    .map((ubicacion, indice) => ({ indice, punto: puntoDelEvento(ubicacion || {}) }))
    .filter(({ punto }) => punto !== null);
}

// Un contexto por punto: la referencia es `<alertaId>#<índice>`. La alerta en
// sí (`<alertaId>` solo) es la marca de baja del grupo.
function referenciaDeUbicacion(alertaId, indice) {
  return `${alertaId}#${indice}`;
}

// Grupo de contextos de la alerta: lo usan el advisory lock que serializa
// confirmación y finalización, y la marca de baja.
function grupoDeLaAlerta(alertaId, origen = ORIGEN_ESPACIOS) {
  return { tipo: CONTEXTO_TIPO.ALERTA_CLIMATICA, origen, referenciaBase: alertaId };
}

function barriosDeLaAlerta(data = {}) {
  return Array.isArray(data.barrios)
    ? data.barrios.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim())
    : [];
}

module.exports = {
  CAUSA_TIPO_CLIMA,
  NIVELES,
  RADIO_CLIMA_DEFAULT_METROS,
  esNivelAccionable,
  severityDelNivel,
  radioClimaMetros,
  nivelNormalizado,
  alertaIdValido,
  fenomenoLegible,
  ubicacionesDeLaAlerta,
  referenciaDeUbicacion,
  grupoDeLaAlerta,
  barriosDeLaAlerta,
};
