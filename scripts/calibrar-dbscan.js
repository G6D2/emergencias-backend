// DATOS SINTÉTICOS -- calibración de los parámetros del agrupamiento de
// incidentes (DbscanGrouper) sobre un dataset generado con semilla fija. NO
// representa patrones reales de reportes de ninguna ciudad: sirve para ver
// cómo se comporta el algoritmo ante dispersión GPS, reportes tardíos, hechos
// vecinos y ruido, y para comparar combinaciones de parámetros entre sí.
//
// No copia el algoritmo: corre el job real (`detectIncidents` de
// src/services/incident-detection-job.js, que llama a
// processEmergencyTypeCandidates -> detectGroups -> DbscanGrouper) contra
// repositorios en memoria y un reloj simulado, una pasada por minuto como en
// producción. Así la ventana temporal, el prefiltro por emergencyType, el
// filtro de ciudadanos únicos y la vinculación incremental a incidentes ya
// existentes funcionan igual que en el backend.
//
// Standalone: no toca Postgres ni Kafka. Método y resultados en
// docs/ml/calibracion-dbscan.md.
//
// Correr con: node scripts/calibrar-dbscan.js [--replicas N] [--semilla S] [--completo]

const { detectIncidents } = require('../src/services/incident-detection-job');
const { groupNearbyEmergencies } = require('../src/domain/rule-based-grouper');
const { groupNearbyEmergenciesDbscan } = require('../src/domain/dbscan-grouper');
const { resolveBarrioFromPoint } = require('../src/domain/barrio');
const { severityForType } = require('../src/domain/severity');

// Defaults de startIncidentDetectionJob (src/services/incident-detection-job.js):
// INCIDENT_RADIUS_M, INCIDENT_MIN_CITIZENS, INCIDENT_WINDOW_MIN e
// INCIDENT_DETECTION_INTERVAL_MS. Si cambian allá, actualizar acá.
const DEFAULTS_ACTUALES = Object.freeze({
  radiusMeters: 300,
  minUniqueCitizens: 2,
  windowMinutes: 15,
  intervalMs: 60000,
});

const BARRIDO = Object.freeze({
  radiusMeters: [50, 100, 150, 200, 250, 300, 500, 800],
  minUniqueCitizens: [2, 3],
  windowMinutes: [5, 10, 15, 30],
});

const SEMILLA_POR_DEFECTO = 1711;
const REPLICAS_POR_DEFECTO = 20;

// Día ficticio: 17/11/2026 de 12:00 a 16:00 (ART).
const INICIO_MS = Date.UTC(2026, 10, 17, 15, 0, 0);
const HORIZONTE_MIN = 240;

// `dispersionMaxM`: distancia máxima entre un reporte y el hecho (GPS +
// posición del testigo). 150 m es el supuesto base; "GPS pobre" lo duplica
// para ver qué pasa si en la calle los teléfonos ubican peor (interiores,
// ubicación por wifi).
const ESCENARIOS = Object.freeze({
  normal: { nombre: 'Normal', hechos: 40, ruido: 120, dispersionMaxM: 150 },
  alta: { nombre: 'Carga alta', hechos: 80, ruido: 480, dispersionMaxM: 150 },
  gpsPobre: { nombre: 'GPS pobre', hechos: 40, ruido: 120, dispersionMaxM: 300 },
});

// Caja que contiene a CABA; los puntos se aceptan solo si caen en un barrio
// (mismo GeoJSON que usa el backend para derivar el barrio).
const CAJA_CABA = Object.freeze({ latMin: -34.705, latMax: -34.527, lngMin: -58.531, lngMax: -58.335 });

// Zonas con más movimiento: la mitad de los hechos y del ruido sale de acá,
// la otra mitad uniforme en la ciudad. Concentrar reportes hace más probable
// que dos hechos distintos queden cerca (caso más exigente que el uniforme).
const ZONAS_CALIENTES = Object.freeze([
  { nombre: 'Obelisco', latitude: -34.6037, longitude: -58.3816 },
  { nombre: 'Constitución', latitude: -34.6277, longitude: -58.3812 },
  { nombre: 'Once', latitude: -34.6090, longitude: -58.4060 },
  { nombre: 'Retiro', latitude: -34.5915, longitude: -58.3745 },
  { nombre: 'Palermo', latitude: -34.5880, longitude: -58.4300 },
  { nombre: 'Flores', latitude: -34.6280, longitude: -58.4630 },
]);
const DESVIO_ZONA_CALIENTE_M = 700;

// Tipos agrupables (todos menos PREVENTIVA) con un peso aproximado de cuán
// seguido aparecen. Supuesto, no medido.
const PESOS_TIPO = Object.freeze([
  ['PANICO', 0.30],
  ['MEDICA', 0.25],
  ['OTRO', 0.10],
  ['INFRAESTRUCTURA', 0.10],
  ['DISTURBIO_EVENTO_MASIVO', 0.10],
  ['INCENDIO', 0.08],
  ['TRANSITO', 0.07],
]);

// Ciudadanos distintos que reportan un mismo hecho.
const PESOS_REPORTANTES = Object.freeze([[2, 0.35], [3, 0.30], [4, 0.15], [5, 0.10], [6, 0.05], [8, 0.05]]);

const DISPERSION_MIN_M = 20; // GPS + posición del testigo respecto del hecho
const DISPERSION_MAX_M = 150; // por defecto; cada escenario puede pisarlo
const DEMORA_MEDIA_MIN = 3; // demora típica de los reportes que siguen al primero
const DEMORA_MAX_MIN = 12;
const PROB_REPORTE_TARDIO = 0.10; // alguien que reporta bastante después
const TARDIO_MIN_MIN = 12;
const TARDIO_MAX_MIN = 25;
const PROB_HECHO_VECINO = 0.20; // otro hecho real del mismo tipo, cerca y casi al mismo tiempo
const VECINO_DISTANCIA_MIN_M = 300;
const VECINO_DISTANCIA_MAX_M = 700;
const VECINO_DESFASAJE_MAX_MIN = 10;
const MARGEN_FINAL_MIN = 30; // los hechos arrancan antes del final, para que todos sus reportes entren en el horizonte

const METROS_POR_GRADO_LAT = 111320;

// --- Azar reproducible ------------------------------------------------------

/** Generador mulberry32: mismo `semilla`, misma secuencia en cualquier máquina. */
function crearGenerador(semilla) {
  let estado = semilla >>> 0;
  return function siguiente() {
    estado = (estado + 0x6D2B79F5) >>> 0;
    let t = estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uniforme(azar, min, max) {
  return min + (max - min) * azar();
}

function normal(azar) {
  // Box-Muller; 1 - azar() evita log(0).
  return Math.sqrt(-2 * Math.log(1 - azar())) * Math.cos(2 * Math.PI * azar());
}

function elegirPonderado(azar, pesos) {
  const total = pesos.reduce((suma, [, peso]) => suma + peso, 0);
  let umbral = azar() * total;
  for (const [valor, peso] of pesos) {
    umbral -= peso;
    if (umbral < 0) return valor;
  }
  return pesos[pesos.length - 1][0];
}

// --- Geografía --------------------------------------------------------------

function desplazar(punto, metros, angulo) {
  const deltaLat = (metros * Math.cos(angulo)) / METROS_POR_GRADO_LAT;
  const deltaLng = (metros * Math.sin(angulo))
    / (METROS_POR_GRADO_LAT * Math.cos((punto.latitude * Math.PI) / 180));
  return { latitude: punto.latitude + deltaLat, longitude: punto.longitude + deltaLng };
}

function estaEnCaba(punto) {
  return resolveBarrioFromPoint(punto.latitude, punto.longitude) !== null;
}

function puntoUniformeEnCaba(azar) {
  for (;;) {
    const punto = {
      latitude: uniforme(azar, CAJA_CABA.latMin, CAJA_CABA.latMax),
      longitude: uniforme(azar, CAJA_CABA.lngMin, CAJA_CABA.lngMax),
    };
    if (estaEnCaba(punto)) return punto;
  }
}

function puntoCercaDeZonaCaliente(azar) {
  const zona = ZONAS_CALIENTES[Math.floor(azar() * ZONAS_CALIENTES.length)];
  for (;;) {
    const metros = Math.abs(normal(azar)) * DESVIO_ZONA_CALIENTE_M;
    const punto = desplazar(zona, metros, uniforme(azar, 0, 2 * Math.PI));
    if (estaEnCaba(punto)) return punto;
  }
}

function puntoEnCiudad(azar) {
  return azar() < 0.5 ? puntoCercaDeZonaCaliente(azar) : puntoUniformeEnCaba(azar);
}

// --- Dataset ----------------------------------------------------------------

function demoraDelReporte(azar) {
  if (azar() < PROB_REPORTE_TARDIO) return uniforme(azar, TARDIO_MIN_MIN, TARDIO_MAX_MIN);
  return Math.min(-DEMORA_MEDIA_MIN * Math.log(1 - azar()), DEMORA_MAX_MIN);
}

/**
 * Genera el dataset de un escenario. Cada reporte trae la verdad de campo
 * (`hechoId`: el hecho real al que pertenece, o null si es ruido aislado),
 * que el job nunca ve: solo se usa para medir.
 *
 * @param {{ semilla: number, hechos: number, ruido: number, dispersionMaxM?: number }} opciones
 * @returns {Array<{ id: string, userId: string, emergencyType: string, severity: string, latitude: number, longitude: number, createdAtMs: number, hechoId: string|null }>}
 */
function generarDataset({ semilla, hechos, ruido, dispersionMaxM = DISPERSION_MAX_M }) {
  const azar = crearGenerador(semilla);
  const reportes = [];
  let ciudadanos = 0;
  let cantidadHechos = 0;

  function agregarHecho(centro, emergencyType, inicioMin) {
    cantidadHechos += 1;
    const hechoId = `h-${String(cantidadHechos).padStart(3, '0')}`;
    const reportantes = elegirPonderado(azar, PESOS_REPORTANTES);
    for (let i = 0; i < reportantes; i += 1) {
      ciudadanos += 1;
      const demoraMin = i === 0 ? 0 : demoraDelReporte(azar);
      const punto = desplazar(
        centro,
        uniforme(azar, DISPERSION_MIN_M, dispersionMaxM),
        uniforme(azar, 0, 2 * Math.PI)
      );
      reportes.push({
        userId: `ciudadano-${ciudadanos}`,
        emergencyType,
        severity: severityForType(emergencyType),
        latitude: punto.latitude,
        longitude: punto.longitude,
        createdAtMs: Math.round(INICIO_MS + (inicioMin + demoraMin) * 60000),
        hechoId,
      });
    }
  }

  for (let n = 0; n < hechos; n += 1) {
    const centro = puntoEnCiudad(azar);
    const emergencyType = elegirPonderado(azar, PESOS_TIPO);
    const inicioMin = uniforme(azar, VECINO_DESFASAJE_MAX_MIN, HORIZONTE_MIN - MARGEN_FINAL_MIN);
    agregarHecho(centro, emergencyType, inicioMin);

    if (azar() < PROB_HECHO_VECINO) {
      const centroVecino = desplazar(
        centro,
        uniforme(azar, VECINO_DISTANCIA_MIN_M, VECINO_DISTANCIA_MAX_M),
        uniforme(azar, 0, 2 * Math.PI)
      );
      const desfasaje = uniforme(azar, -VECINO_DESFASAJE_MAX_MIN, VECINO_DESFASAJE_MAX_MIN);
      agregarHecho(centroVecino, emergencyType, inicioMin + desfasaje);
    }
  }

  for (let n = 0; n < ruido; n += 1) {
    ciudadanos += 1;
    const punto = puntoEnCiudad(azar);
    const emergencyType = elegirPonderado(azar, PESOS_TIPO);
    reportes.push({
      userId: `ciudadano-${ciudadanos}`,
      emergencyType,
      severity: severityForType(emergencyType),
      latitude: punto.latitude,
      longitude: punto.longitude,
      createdAtMs: Math.round(INICIO_MS + uniforme(azar, 0, HORIZONTE_MIN) * 60000),
      hechoId: null,
    });
  }

  reportes.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return reportes.map((reporte, index) => ({ id: `e-${String(index + 1).padStart(4, '0')}`, ...reporte }));
}

// --- Simulación del job ------------------------------------------------------

function primerIndiceDesde(tiempos, valor) {
  let bajo = 0;
  let alto = tiempos.length;
  while (bajo < alto) {
    const medio = (bajo + alto) >>> 1;
    if (tiempos[medio] < valor) bajo = medio + 1;
    else alto = medio;
  }
  return bajo;
}

function primerIndiceDespuesDe(tiempos, valor) {
  return primerIndiceDesde(tiempos, valor + 1);
}

/**
 * Corre el job real de detección (`detectIncidents`) una vez por intervalo
 * sobre un reloj simulado. Los repositorios en memoria imitan lo que el job
 * usa de los reales: findRecentByType (created_at >= since, sin estados
 * terminales: acá ninguno se cierra) y create/addMember/applyScoringDecision.
 *
 * @returns {Promise<{ incidentePorEmergencia: Map<string, string>, incidentes: Map<string, object> }>}
 */
async function simularJob(reportes, { radiusMeters, minUniqueCitizens, windowMinutes, intervalMs = DEFAULTS_ACTUALES.intervalMs }) {
  const ordenados = [...reportes].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const tiempos = ordenados.map((reporte) => reporte.createdAtMs);
  const incidentePorEmergencia = new Map();
  const incidentes = new Map();
  let ahora = INICIO_MS;

  const emergencyRepository = {
    async findRecentByType({ emergencyTypes, since }) {
      const desde = primerIndiceDesde(tiempos, since.getTime());
      const hasta = primerIndiceDespuesDe(tiempos, ahora);
      const candidatos = [];
      for (let i = desde; i < hasta; i += 1) {
        const reporte = ordenados[i];
        if (!emergencyTypes.includes(reporte.emergencyType)) continue;
        candidatos.push({
          id: reporte.id,
          correlationId: reporte.id,
          userId: reporte.userId,
          emergencyType: reporte.emergencyType,
          latitude: reporte.latitude,
          longitude: reporte.longitude,
          severity: reporte.severity,
          incidentId: incidentePorEmergencia.get(reporte.id) ?? null,
          createdAt: new Date(reporte.createdAtMs),
        });
      }
      return candidatos;
    },
  };

  const incidentRepository = {
    async create({ emergencyType }) {
      const id = `inc-${incidentes.size + 1}`;
      incidentes.set(id, { id, emergencyType });
      return { id };
    },
    async addMember(incidentId, emergencyId) {
      incidentePorEmergencia.set(emergencyId, incidentId);
    },
    async applyScoringDecision(incidentId, { priority, score, algorithmVersion }) {
      Object.assign(incidentes.get(incidentId), { priority, score, algorithmVersion });
    },
  };

  const finMs = tiempos.length > 0 ? tiempos[tiempos.length - 1] + intervalMs : INICIO_MS;
  // processEmergencyTypeCandidates calcula la recencia del score con
  // Date.now(): se fija al reloj simulado mientras dura la corrida.
  const relojReal = Date.now;
  try {
    for (ahora = INICIO_MS; ahora <= finMs; ahora += intervalMs) {
      const momento = ahora;
      Date.now = () => momento;
      await detectIncidents({
        emergencyRepository,
        incidentRepository,
        since: new Date(momento - windowMinutes * 60000),
        radiusMeters,
        minUniqueCitizens,
      });
    }
  } finally {
    Date.now = relojReal;
  }

  return { incidentePorEmergencia, incidentes };
}

// --- Métricas ----------------------------------------------------------------

function paresDe(n) {
  return (n * (n - 1)) / 2;
}

function contar(mapa, clave) {
  mapa.set(clave, (mapa.get(clave) || 0) + 1);
}

/**
 * Compara el agrupamiento del job con la verdad de campo.
 * - Pares: un par de reportes "va junto" si es del mismo hecho real; el job
 *   lo junta si los dos quedaron en el mismo incidente. Un reporte sin
 *   incidente cuenta como grupo de uno.
 * - ARI (Adjusted Rand Index): 1 = agrupamiento idéntico a la verdad, ~0 =
 *   no mejor que el azar.
 * - Hecho detectado: al menos 2 de sus reportes en un mismo incidente.
 * - Hecho partido: sus reportes quedaron en 2 o más incidentes distintos.
 * - Fusión: incidente que mezcla reportes de 2 o más hechos reales.
 * - Incidente falso: ningún hecho real aporta 2 reportes (lo armó el ruido).
 */
function evaluar(reportes, incidentePorEmergencia) {
  const verdad = (reporte) => reporte.hechoId ?? `ruido:${reporte.id}`;
  const prediccion = (reporte) => incidentePorEmergencia.get(reporte.id) ?? `solo:${reporte.id}`;

  const porVerdad = new Map();
  const porPrediccion = new Map();
  const porCelda = new Map();
  const miembrosPorIncidente = new Map();
  const incidentesPorHecho = new Map();

  for (const reporte of reportes) {
    contar(porVerdad, verdad(reporte));
    contar(porPrediccion, prediccion(reporte));
    contar(porCelda, `${verdad(reporte)}|${prediccion(reporte)}`);

    const incidentId = incidentePorEmergencia.get(reporte.id);
    if (incidentId) {
      if (!miembrosPorIncidente.has(incidentId)) miembrosPorIncidente.set(incidentId, []);
      miembrosPorIncidente.get(incidentId).push(reporte);
    }
    if (reporte.hechoId) {
      if (!incidentesPorHecho.has(reporte.hechoId)) incidentesPorHecho.set(reporte.hechoId, new Map());
      if (incidentId) contar(incidentesPorHecho.get(reporte.hechoId), incidentId);
    }
  }

  const sumar = (mapa) => [...mapa.values()].reduce((suma, n) => suma + paresDe(n), 0);
  const paresJuntosBien = sumar(porCelda);
  const paresVerdad = sumar(porVerdad);
  const paresPrediccion = sumar(porPrediccion);
  const paresTotales = paresDe(reportes.length);

  const precision = paresPrediccion === 0 ? 1 : paresJuntosBien / paresPrediccion;
  const recall = paresVerdad === 0 ? 1 : paresJuntosBien / paresVerdad;
  const esperado = paresTotales === 0 ? 0 : (paresVerdad * paresPrediccion) / paresTotales;
  const maximo = (paresVerdad + paresPrediccion) / 2;
  const ari = maximo === esperado ? 1 : (paresJuntosBien - esperado) / (maximo - esperado);

  let fusiones = 0;
  let incidentesFalsos = 0;
  for (const miembros of miembrosPorIncidente.values()) {
    const porHecho = new Map();
    miembros.filter((m) => m.hechoId).forEach((m) => contar(porHecho, m.hechoId));
    if (porHecho.size >= 2) fusiones += 1;
    if (![...porHecho.values()].some((n) => n >= 2)) incidentesFalsos += 1;
  }

  let hechosDetectados = 0;
  let hechosPartidos = 0;
  for (const incidentesDelHecho of incidentesPorHecho.values()) {
    if ([...incidentesDelHecho.values()].some((n) => n >= 2)) hechosDetectados += 1;
    if (incidentesDelHecho.size >= 2) hechosPartidos += 1;
  }

  const ruido = reportes.filter((r) => !r.hechoId);
  const ruidoAgrupado = ruido.filter((r) => incidentePorEmergencia.has(r.id)).length;

  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    ari,
    hechos: incidentesPorHecho.size,
    hechosDetectados,
    hechosPartidos,
    incidentes: miembrosPorIncidente.size,
    fusiones,
    incidentesFalsos,
    ruido: ruido.length,
    ruidoAgrupado,
  };
}

// --- Barrido -----------------------------------------------------------------

function combinaciones() {
  const lista = [];
  for (const radiusMeters of BARRIDO.radiusMeters) {
    for (const minUniqueCitizens of BARRIDO.minUniqueCitizens) {
      for (const windowMinutes of BARRIDO.windowMinutes) {
        lista.push({ radiusMeters, minUniqueCitizens, windowMinutes });
      }
    }
  }
  return lista;
}

function promediar(resultados) {
  const claves = Object.keys(resultados[0]);
  const promedio = {};
  for (const clave of claves) {
    promedio[clave] = resultados.reduce((suma, r) => suma + r[clave], 0) / resultados.length;
  }
  return promedio;
}

/**
 * Corre el barrido completo de un escenario: cada combinación sobre las
 * mismas `replicas` datasets (semilla, semilla + 1, ...) y promedia.
 */
async function barrerEscenario(escenario, { semilla, replicas, parametros = combinaciones() }) {
  const datasets = [];
  for (let r = 0; r < replicas; r += 1) {
    datasets.push(generarDataset({ ...escenario, semilla: semilla + r }));
  }

  const filas = [];
  const algoritmos = new Map();
  for (const params of parametros) {
    const porReplica = [];
    for (const dataset of datasets) {
      const { incidentePorEmergencia, incidentes } = await simularJob(dataset, params);
      porReplica.push(evaluar(dataset, incidentePorEmergencia));
      for (const incidente of incidentes.values()) contar(algoritmos, incidente.algorithmVersion);
    }
    filas.push({ ...params, ...promediar(porReplica) });
  }

  return {
    filas,
    algoritmos,
    reportesPorReplica: datasets.reduce((suma, d) => suma + d.length, 0) / datasets.length,
    hechosPorReplica: datasets.reduce((suma, d) => suma + new Set(d.filter((r) => r.hechoId).map((r) => r.hechoId)).size, 0) / datasets.length,
  };
}

// --- DBSCAN contra el fallback -------------------------------------------------

function firmaDeGrupos(grupos) {
  return grupos.map((grupo) => [...grupo].sort().join(',')).sort().join('|');
}

/**
 * Para cada minuto y cada emergencyType, arma los candidatos de la ventana
 * (el mismo prefiltro que hace findRecentByType) y les pasa los dos
 * agrupadores reales: DbscanGrouper y RuleBasedGrouper (el fallback). Cuenta
 * en cuántas ventanas dan grupos distintos.
 */
function compararConFallback(reportes, { radiusMeters, minUniqueCitizens, windowMinutes, intervalMs = DEFAULTS_ACTUALES.intervalMs }) {
  let ventanas = 0;
  let distintas = 0;
  if (reportes.length === 0) return { ventanas, distintas };

  const ultimo = reportes[reportes.length - 1].createdAtMs;
  for (let ahora = INICIO_MS; ahora <= ultimo + intervalMs; ahora += intervalMs) {
    const porTipo = new Map();
    for (const reporte of reportes) {
      if (reporte.createdAtMs < ahora - windowMinutes * 60000 || reporte.createdAtMs > ahora) continue;
      if (!porTipo.has(reporte.emergencyType)) porTipo.set(reporte.emergencyType, []);
      porTipo.get(reporte.emergencyType).push({ ...reporte, emergencyId: reporte.id });
    }
    for (const candidatos of porTipo.values()) {
      ventanas += 1;
      const opciones = { radiusMeters, minUniqueCitizens };
      if (firmaDeGrupos(groupNearbyEmergenciesDbscan(candidatos, opciones))
        !== firmaDeGrupos(groupNearbyEmergencies(candidatos, opciones))) {
        distintas += 1;
      }
    }
  }
  return { ventanas, distintas };
}

// --- Salida ------------------------------------------------------------------

function decimal(valor, digitos = 2) {
  return valor.toFixed(digitos).replace('.', ',');
}

function porcentaje(parte, total) {
  return total === 0 ? '—' : `${decimal((100 * parte) / total, 0)} %`;
}

function esDefault(fila) {
  return fila.radiusMeters === DEFAULTS_ACTUALES.radiusMeters
    && fila.minUniqueCitizens === DEFAULTS_ACTUALES.minUniqueCitizens
    && fila.windowMinutes === DEFAULTS_ACTUALES.windowMinutes;
}

function tabla(filas) {
  const lineas = [
    '| eps (m) | minPts | ventana (min) | precisión pares | recall pares | ARI | hechos detectados | hechos partidos | fusiones | incidentes falsos | ruido agrupado |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const f of filas) {
    const marca = esDefault(f) ? ' (actual)' : '';
    lineas.push(`| ${f.radiusMeters}${marca} | ${f.minUniqueCitizens} | ${f.windowMinutes} | ${decimal(f.precision)} | ${decimal(f.recall)} | ${decimal(f.ari)} | ${porcentaje(f.hechosDetectados, f.hechos)} | ${decimal(f.hechosPartidos, 1)} | ${decimal(f.fusiones, 1)} | ${decimal(f.incidentesFalsos, 1)} | ${porcentaje(f.ruidoAgrupado, f.ruido)} |`);
  }
  return lineas.join('\n');
}

function claveDe({ radiusMeters, minUniqueCitizens, windowMinutes }) {
  return `${radiusMeters}|${minUniqueCitizens}|${windowMinutes}`;
}

/**
 * Junta, por combinación de parámetros, el ARI y los hechos detectados de
 * cada escenario, y ordena por el ARI del peor escenario (desempate: ARI
 * promedio). Como no sabemos cuál escenario se parece más a la realidad, se
 * elige lo que mejor aguanta el caso desfavorable.
 *
 * @param {Record<string, Array<object>>} filasPorEscenario
 */
function resumirEntreEscenarios(filasPorEscenario) {
  const porCombinacion = new Map();
  for (const [escenario, filas] of Object.entries(filasPorEscenario)) {
    for (const fila of filas) {
      const clave = claveDe(fila);
      if (!porCombinacion.has(clave)) {
        porCombinacion.set(clave, {
          radiusMeters: fila.radiusMeters,
          minUniqueCitizens: fila.minUniqueCitizens,
          windowMinutes: fila.windowMinutes,
          porEscenario: {},
        });
      }
      porCombinacion.get(clave).porEscenario[escenario] = {
        ari: fila.ari,
        detectados: fila.hechos === 0 ? 1 : fila.hechosDetectados / fila.hechos,
      };
    }
  }

  const resumen = [...porCombinacion.values()].map((combinacion) => {
    const aris = Object.values(combinacion.porEscenario).map((r) => r.ari);
    return {
      ...combinacion,
      ariMinimo: Math.min(...aris),
      ariPromedio: aris.reduce((suma, ari) => suma + ari, 0) / aris.length,
    };
  });
  return resumen.sort((a, b) => b.ariMinimo - a.ariMinimo || b.ariPromedio - a.ariPromedio);
}

function tablaResumen(resumen, escenarios) {
  const columnas = escenarios.map((e) => `ARI ${ESCENARIOS[e].nombre} (detectados)`);
  const lineas = [
    `| eps (m) | minPts | ventana (min) | ${columnas.join(' | ')} | ARI peor escenario |`,
    `|---:|---:|---:|${escenarios.map(() => '---:').join('|')}|---:|`,
  ];
  for (const r of resumen) {
    const marca = esDefault(r) ? ' (actual)' : '';
    const celdas = escenarios.map((e) => {
      const { ari, detectados } = r.porEscenario[e];
      return `${decimal(ari)} (${decimal(100 * detectados, 0)} %)`;
    });
    lineas.push(`| ${r.radiusMeters}${marca} | ${r.minUniqueCitizens} | ${r.windowMinutes} | ${celdas.join(' | ')} | ${decimal(r.ariMinimo)} |`);
  }
  return lineas.join('\n');
}

function leerArgumentos(argv) {
  const opciones = { semilla: SEMILLA_POR_DEFECTO, replicas: REPLICAS_POR_DEFECTO, completo: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--completo') opciones.completo = true;
    else if (argv[i] === '--semilla') opciones.semilla = Number(argv[++i]);
    else if (argv[i] === '--replicas') opciones.replicas = Number(argv[++i]);
    else throw new Error(`Argumento desconocido: ${argv[i]}`);
  }
  if (!Number.isInteger(opciones.semilla)) throw new Error('--semilla tiene que ser un entero');
  if (!Number.isInteger(opciones.replicas) || opciones.replicas < 1) throw new Error('--replicas tiene que ser un entero >= 1');
  return opciones;
}

async function main() {
  const opciones = leerArgumentos(process.argv.slice(2));
  // Los grupos salteados por AMBIGUOUS_EXISTING_INCIDENTS se loguean como
  // warn en cada pasada: en el barrido son ruido de consola.
  if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'error';

  console.log('=== Calibración de DbscanGrouper (DATOS SINTÉTICOS) ===\n');
  console.log(`Semilla ${opciones.semilla}, ${opciones.replicas} réplicas por escenario (semillas ${opciones.semilla}..${opciones.semilla + opciones.replicas - 1}).`);
  console.log(`Defaults actuales: eps=${DEFAULTS_ACTUALES.radiusMeters} m, minPts=${DEFAULTS_ACTUALES.minUniqueCitizens}, ventana=${DEFAULTS_ACTUALES.windowMinutes} min, job cada ${DEFAULTS_ACTUALES.intervalMs / 1000} s.`);
  console.log('Los valores son promedios entre réplicas; hechos partidos, fusiones e incidentes falsos son cantidades por réplica.\n');

  const filasPorEscenario = {};
  for (const [clave, escenario] of Object.entries(ESCENARIOS)) {
    const inicio = process.hrtime.bigint();
    const { filas, algoritmos, reportesPorReplica, hechosPorReplica } = await barrerEscenario(escenario, opciones);
    const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;

    console.log(`## Escenario "${escenario.nombre}" (${clave}): ${HORIZONTE_MIN / 60} h, ~${Math.round(reportesPorReplica)} reportes, ~${Math.round(hechosPorReplica)} hechos reales, ${escenario.ruido} reportes aislados, dispersión ${DISPERSION_MIN_M}-${escenario.dispersionMaxM} m`);
    console.log(`Incidentes creados en el barrido, por estrategia: ${[...algoritmos].map(([v, n]) => `${v} ×${n}`).join(', ')} (${decimal(segundos, 1)} s)\n`);

    console.log(`### eps × minPts con la ventana actual (${DEFAULTS_ACTUALES.windowMinutes} min)\n`);
    console.log(tabla(filas.filter((f) => f.windowMinutes === DEFAULTS_ACTUALES.windowMinutes)));

    console.log('\n### Ventana × eps con minPts = 2\n');
    console.log(tabla(filas
      .filter((f) => f.minUniqueCitizens === 2 && [200, 250, 300].includes(f.radiusMeters))
      .sort((a, b) => a.radiusMeters - b.radiusMeters || a.windowMinutes - b.windowMinutes)));

    if (opciones.completo) {
      console.log('\n### Barrido completo\n');
      console.log(tabla(filas));
    }
    console.log('');
    filasPorEscenario[clave] = filas;
  }

  console.log('## Resumen entre escenarios (criterio de elección: el mejor ARI en el peor escenario)\n');
  const resumen = resumirEntreEscenarios(filasPorEscenario);
  const mostrar = resumen.slice(0, 8);
  if (!mostrar.some(esDefault)) mostrar.push(resumen.find(esDefault));
  console.log(tablaResumen(mostrar, Object.keys(filasPorEscenario)));

  console.log(`\n## DBSCAN contra el fallback (RuleBasedGrouper), eps=${DEFAULTS_ACTUALES.radiusMeters} m y ventana ${DEFAULTS_ACTUALES.windowMinutes} min, primera réplica de cada escenario\n`);
  for (const minUniqueCitizens of BARRIDO.minUniqueCitizens) {
    let ventanas = 0;
    let distintas = 0;
    for (const escenario of Object.values(ESCENARIOS)) {
      const resultado = compararConFallback(
        generarDataset({ ...escenario, semilla: opciones.semilla }),
        { ...DEFAULTS_ACTUALES, minUniqueCitizens }
      );
      ventanas += resultado.ventanas;
      distintas += resultado.distintas;
    }
    console.log(`minPts=${minUniqueCitizens}: grupos distintos en ${distintas} de ${ventanas} ventanas (por minuto y por tipo)`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS_ACTUALES,
  BARRIDO,
  ESCENARIOS,
  INICIO_MS,
  DISPERSION_MIN_M,
  DISPERSION_MAX_M,
  crearGenerador,
  generarDataset,
  simularJob,
  evaluar,
  barrerEscenario,
  resumirEntreEscenarios,
  compararConFallback,
};
