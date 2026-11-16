// Alerta climática de Espacios (issues #80 y #88 del board).
//
// Espacios consulta Open-Meteo, un administrador confirma la criticidad y
// publica `CriticidadClimaticaConfirmada`; al vencer o cerrarse a mano publica
// `CriticidadClimaticaFinalizada` con el mismo `alertaId`. El payload
// confirmado trae `alertaId`, `nivelCriticidad`, `fenomeno`,
// `ubicaciones: [{ latitud, longitud }]`, `barrios`, `vigenciaDesde` y
// `vigenciaHasta` (epoch ms). Una alerta confirmada no cambia de cobertura:
// si cambia, Espacios genera otra alerta.
//
// Dos efectos en Emergencias:
// - Un contexto de zona ALERTA_CLIMATICA por cada punto de `ubicaciones`,
//   con un radio propio del clima (los puntos son los de la consulta
//   meteorológica, no un lugar puntual como un evento).
// - Con nivel ALTA o CRITICA, una emergencia PREVENTIVA por `alertaId`
//   (causaTipo EVENTO_CLIMATICO). BAJA y MEDIA solo dejan el contexto: para
//   Espacios tampoco son accionables.

const { puntoDelEvento } = require('./contexto-zona');

const CAUSA_TIPO_CLIMA = 'EVENTO_CLIMATICO';

const DEFAULT_TOPIC_CONFIRMADA = 'com.citypass.espacios.CriticidadClimaticaConfirmada';
const DEFAULT_TOPIC_FINALIZADA = 'com.citypass.espacios.CriticidadClimaticaFinalizada';

const NIVEL_TO_SEVERITY = Object.freeze({
  BAJA: 'low',
  MEDIA: 'medium',
  ALTA: 'high',
  CRITICA: 'critical',
});

const NIVELES_CON_EMERGENCIA = new Set(['ALTA', 'CRITICA']);

// Radio de cada punto de la alerta. No hay radio natural para una tormenta
// (ADR "Elevar la prioridad en un radio alrededor del evento", pregunta
// abierta): es un valor de arranque, configurable por entorno.
const RADIO_CLIMA_DEFAULT_METROS = 2000;

function radioClimaMetros(env = process.env) {
  const metros = Number(env.CONTEXTO_ZONA_RADIO_CLIMA_METROS);
  return Number.isFinite(metros) && metros > 0 ? Math.round(metros) : RADIO_CLIMA_DEFAULT_METROS;
}

// Nivel en mayúsculas sin tilde (CRÍTICA → CRITICA), o null si no es del catálogo.
function nivelNormalizado(nivel) {
  if (typeof nivel !== 'string') return null;
  const limpio = nivel.trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return Object.prototype.hasOwnProperty.call(NIVEL_TO_SEVERITY, limpio) ? limpio : null;
}

function alertaIdValido(alertaId) {
  return typeof alertaId === 'string' && alertaId.trim().length > 0 && alertaId === alertaId.trim();
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

function barriosDeLaAlerta(data = {}) {
  return Array.isArray(data.barrios)
    ? data.barrios.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim())
    : [];
}

module.exports = {
  CAUSA_TIPO_CLIMA,
  DEFAULT_TOPIC_CONFIRMADA,
  DEFAULT_TOPIC_FINALIZADA,
  NIVEL_TO_SEVERITY,
  NIVELES_CON_EMERGENCIA,
  RADIO_CLIMA_DEFAULT_METROS,
  radioClimaMetros,
  nivelNormalizado,
  alertaIdValido,
  ubicacionesDeLaAlerta,
  referenciaDeUbicacion,
  barriosDeLaAlerta,
};
