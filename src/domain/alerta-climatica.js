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
// - un contexto de zona ALERTA_CLIMATICA por cada barrio de la alerta, con
//   el círculo que cubre el barrio (ver zonaDelBarrio en domain/barrio.js).
//   Al vincular, la emergencia además tiene que ser de ese barrio, así el
//   círculo no alcanza a los vecinos. Si la alerta no trae ningún barrio del
//   catálogo, un contexto por cada punto de `ubicaciones`, con el radio del
//   nivel (CRITICA 1000 m, ALTA 500 m, configurables);
// - una emergencia PREVENTIVA por `alertaId` (causaTipo EVENTO_CLIMATICO),
//   con la severidad del nivel.
// BAJA y MEDIA no generan nada.

const { CONTEXTO_TIPO, ORIGEN_ESPACIOS, puntoDelEvento } = require('./contexto-zona');
const { zonaDelBarrio } = require('./barrio');

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
  return typeof nivel === 'string' && Object.hasOwn(POLITICA_POR_NIVEL, nivel) ? POLITICA_POR_NIVEL[nivel] : null;
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
    ? fenomeno.trim().replaceAll('_', ' ').toLowerCase()
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

// Zonas de la alerta, una por contexto: { indice, latitud, longitud,
// radioMetros, barrio }.
// - Por barrio: cada barrio de `barrios` que está en el catálogo, con su
//   círculo y su nombre canónico. El índice es la posición en `barrios` (un
//   barrio inválido se descarta sin correr el índice de los demás) y cada
//   barrio va una sola vez.
// - Por punto (si no queda ningún barrio válido): cada punto válido de
//   `ubicaciones`, con el radio del nivel y barrio null.
// El índice forma la referencia `<alertaId>#<índice>` y tiene que ser estable
// entre reentregas del mismo evento.
function zonasDeLaAlerta(data = {}, nivel = null, env = process.env) {
  const barrios = Array.isArray(data.barrios) ? data.barrios : [];
  const vistos = new Set();
  const porBarrio = [];
  barrios.forEach((nombre, indice) => {
    const zona = typeof nombre === 'string' ? zonaDelBarrio(nombre) : null;
    if (!zona || vistos.has(zona.barrio)) return;
    vistos.add(zona.barrio);
    porBarrio.push({
      indice, latitud: zona.latitud, longitud: zona.longitud, radioMetros: zona.radioMetros, barrio: zona.barrio,
    });
  });
  if (porBarrio.length > 0) return porBarrio;

  const radioMetros = radioClimaMetros(nivel, env);
  return ubicacionesDeLaAlerta(data).map(({ indice, punto }) => ({ indice, ...punto, radioMetros, barrio: null }));
}

// ---------------------------------------------------------------------------
// Datos para mostrar la alerta (banner del tablero, GET
// /api/contextos-zona/activos). No intervienen en la zona ni en la suba.

// Catálogo de fenómenos de Espacios (guía "CityPass Eventos climáticos",
// 13/11/2026) con la etiqueta para mostrar. Tabla del PR #121. Espacios
// define el catálogo; sumar un fenómeno es sumar una entrada.
const FENOMENOS = Object.freeze({
  TORMENTA_FUERTE: 'Tormenta fuerte',
  LLUVIA_INTENSA: 'Lluvia intensa',
  VIENTO_FUERTE: 'Viento fuerte',
  OLA_DE_CALOR: 'Ola de calor',
  OLA_DE_FRIO: 'Ola de frío',
  GRANIZO: 'Granizo',
  TORMENTA_ELECTRICA: 'Tormenta eléctrica',
  HURACAN: 'Huracán',
  NIEVE: 'Nieve',
});

// Topes de lo que se guarda en el contexto: el texto viene del bus y solo se
// muestra. CABA tiene 48 barrios.
const MAX_FENOMENO_LENGTH = 60;
const MAX_BARRIOS = 48;
const MAX_BARRIO_LENGTH = 80;

// Código del fenómeno en mayúsculas ("tormenta_fuerte" → "TORMENTA_FUERTE"),
// o null. No valida contra el catálogo: un fenómeno nuevo de Espacios se
// guarda igual y se muestra con etiqueta genérica.
function fenomenoNormalizado(fenomeno) {
  if (typeof fenomeno !== 'string' || !fenomeno.trim()) return null;
  return fenomeno.trim().toUpperCase().slice(0, MAX_FENOMENO_LENGTH);
}

// "TORMENTA_ELECTRICA" → "Tormenta eléctrica". Fuera del catálogo, el código
// legible ("OLA_POLAR" → "Ola polar"). null sin fenómeno.
function etiquetaFenomeno(fenomeno) {
  const codigo = fenomenoNormalizado(fenomeno);
  if (!codigo) return null;
  if (Object.hasOwn(FENOMENOS, codigo)) return FENOMENOS[codigo];
  const palabras = codigo.toLowerCase().split('_').filter(Boolean).join(' ');
  return palabras ? palabras.charAt(0).toUpperCase() + palabras.slice(1) : null;
}

// Barrios de la alerta tal como los manda Espacios, sin repetidos y con tope.
// La zona de los contextos no sale de acá sino de zonasDeLaAlerta, que solo
// toma los barrios del catálogo.
function barriosParaMostrar(data = {}) {
  const barrios = barriosDeLaAlerta(data).map((b) => b.slice(0, MAX_BARRIO_LENGTH));
  return [...new Set(barrios)].slice(0, MAX_BARRIOS);
}

// `<alertaId>#<índice>` → alertaId. null para la marca de baja (`<alertaId>`
// solo) o cualquier otra referencia. El alertaId puede tener '#': se corta en
// el último.
function alertaIdDeReferencia(referencia) {
  if (typeof referencia !== 'string') return null;
  const corte = referencia.lastIndexOf('#');
  if (corte <= 0) return null;
  return /^\d+$/.test(referencia.slice(corte + 1)) ? referencia.slice(0, corte) : null;
}

const ORDEN_NIVEL = Object.freeze({ CRITICA: 0, ALTA: 1 });

function timeOf(fecha) {
  const ms = fecha instanceof Date ? fecha.getTime() : new Date(fecha).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function compararAlertas(a, b) {
  const nivel = (ORDEN_NIVEL[a.nivel] ?? 2) - (ORDEN_NIVEL[b.nivel] ?? 2);
  if (nivel !== 0) return nivel;
  const desde = (timeOf(a.vigenteDesde) ?? 0) - (timeOf(b.vigenteDesde) ?? 0);
  if (desde !== 0) return desde;
  return a.alertaId.localeCompare(b.alertaId);
}

function barriosDelContexto(contexto) {
  return Array.isArray(contexto.barrios) ? contexto.barrios.filter((b) => typeof b === 'string' && b) : [];
}

function alertaDesdeContexto(alertaId, contexto) {
  const barrios = barriosDelContexto(contexto);
  return {
    alertaId,
    nivel: contexto.nivelCriticidad ?? null,
    fenomeno: contexto.fenomeno ?? null,
    fenomenoEtiqueta: etiquetaFenomeno(contexto.fenomeno),
    barrios,
    // BARRIOS: la suba es en los barrios de la alerta (cada uno con su
    // círculo). PUNTOS: alrededor de los puntos, con el radio del nivel.
    zona: barrios.length > 0 ? 'BARRIOS' : 'PUNTOS',
    vigenteDesde: contexto.vigenteDesde ?? null,
    vigenteHasta: contexto.vigenteHasta ?? null,
    enCurso: contexto.enCurso === true,
    puntos: 1,
    // Con zona por barrio cada contexto tiene el radio de su barrio: un solo
    // número no describe la alerta.
    radioMetros: barrios.length > 0 ? null : contexto.radioMetros ?? null,
    descripcion: contexto.descripcion ?? null,
  };
}

// Una entrada por alerta a partir de sus contextos activos (uno por barrio o
// uno por punto). Los contextos de una alerta se registran juntos, en la
// misma transacción y con los mismos datos (nivel, fenómeno, ventana): se
// toman del primero, se cuentan los contextos (`puntos`) y se juntan los
// barrios sin repetir. Primero las CRITICA, después por inicio.
function resumirAlertasActivas(contextos = []) {
  const porAlerta = new Map();
  for (const contexto of contextos) {
    if (contexto?.tipo !== CONTEXTO_TIPO.ALERTA_CLIMATICA) continue;
    const alertaId = alertaIdDeReferencia(contexto.referenciaExterna);
    if (!alertaId) continue;

    const actual = porAlerta.get(alertaId);
    if (actual) {
      actual.puntos += 1;
      actual.enCurso = actual.enCurso || contexto.enCurso === true;
      for (const barrio of barriosDelContexto(contexto)) {
        if (!actual.barrios.includes(barrio)) actual.barrios.push(barrio);
      }
      if (actual.barrios.length > 0) {
        actual.zona = 'BARRIOS';
        actual.radioMetros = null;
      }
    } else {
      porAlerta.set(alertaId, alertaDesdeContexto(alertaId, contexto));
    }
  }
  return [...porAlerta.values()].sort(compararAlertas);
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
  zonasDeLaAlerta,
  referenciaDeUbicacion,
  grupoDeLaAlerta,
  barriosDeLaAlerta,
  FENOMENOS,
  fenomenoNormalizado,
  etiquetaFenomeno,
  barriosParaMostrar,
  alertaIdDeReferencia,
  resumirAlertasActivas,
};
