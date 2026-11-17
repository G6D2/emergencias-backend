const {
  DEFAULTS_ACTUALES,
  ESCENARIOS,
  INICIO_MS,
  DISPERSION_MAX_M,
  crearGenerador,
  generarDataset,
  simularJob,
  evaluar,
  resumirEntreEscenarios,
  compararConFallback,
} = require('../../scripts/calibrar-dbscan');
const { haversineDistanceMeters } = require('../domain/rule-based-grouper');
const { resolveBarrioFromPoint } = require('../domain/barrio');

const SEMILLA = 1711;

function reporte(id, hechoId) {
  return { id, hechoId };
}

describe('scripts/calibrar-dbscan', () => {
  const logLevelOriginal = process.env.LOG_LEVEL;

  beforeAll(() => {
    // Los grupos AMBIGUOUS_EXISTING_INCIDENTS se loguean como warn en cada pasada.
    process.env.LOG_LEVEL = 'error';
  });

  afterAll(() => {
    if (logLevelOriginal === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = logLevelOriginal;
  });

  describe('crearGenerador', () => {
    it('con la misma semilla repite la secuencia', () => {
      const a = crearGenerador(SEMILLA);
      const b = crearGenerador(SEMILLA);
      const secuenciaA = Array.from({ length: 5 }, () => a());
      const secuenciaB = Array.from({ length: 5 }, () => b());

      expect(secuenciaA).toEqual(secuenciaB);
      secuenciaA.forEach((valor) => {
        expect(valor).toBeGreaterThanOrEqual(0);
        expect(valor).toBeLessThan(1);
      });
    });
  });

  describe('generarDataset', () => {
    const dataset = generarDataset({ ...ESCENARIOS.normal, semilla: SEMILLA });

    it('es estable con la semilla fija y cambia con otra semilla', () => {
      expect(generarDataset({ ...ESCENARIOS.normal, semilla: SEMILLA })).toEqual(dataset);
      expect(generarDataset({ ...ESCENARIOS.normal, semilla: SEMILLA + 1 })).not.toEqual(dataset);
    });

    it('arma hechos con varios ciudadanos distintos, cerca entre sí, y el ruido pedido', () => {
      const ruido = dataset.filter((r) => r.hechoId === null);
      expect(ruido).toHaveLength(ESCENARIOS.normal.ruido);

      const porHecho = new Map();
      dataset.filter((r) => r.hechoId).forEach((r) => {
        if (!porHecho.has(r.hechoId)) porHecho.set(r.hechoId, []);
        porHecho.get(r.hechoId).push(r);
      });
      expect(porHecho.size).toBeGreaterThanOrEqual(ESCENARIOS.normal.hechos);

      for (const reportes of porHecho.values()) {
        expect(reportes.length).toBeGreaterThanOrEqual(2);
        expect(new Set(reportes.map((r) => r.emergencyType)).size).toBe(1);
        for (let i = 0; i < reportes.length; i += 1) {
          for (let j = i + 1; j < reportes.length; j += 1) {
            // Cada reporte está a <= DISPERSION_MAX_M del hecho: entre dos
            // reportes del mismo hecho hay como mucho el doble.
            expect(haversineDistanceMeters(reportes[i], reportes[j])).toBeLessThanOrEqual(2 * DISPERSION_MAX_M + 1);
          }
        }
      }
    });

    it('usa ids y ciudadanos únicos, ruido dentro de CABA y solo tipos agrupables', () => {
      expect(new Set(dataset.map((r) => r.id)).size).toBe(dataset.length);
      expect(new Set(dataset.map((r) => r.userId)).size).toBe(dataset.length);
      dataset.forEach((r) => {
        expect(r.emergencyType).not.toBe('PREVENTIVA');
        expect(r.createdAtMs).toBeGreaterThanOrEqual(INICIO_MS);
      });
      // El centro de cada hecho cae en CABA; un testigo a 150 m de un hecho
      // sobre el borde puede quedar del otro lado de la General Paz.
      dataset.filter((r) => r.hechoId === null).forEach((r) => {
        expect(resolveBarrioFromPoint(r.latitude, r.longitude)).not.toBeNull();
      });
    });
  });

  describe('evaluar', () => {
    const reportes = [
      reporte('a1', 'h1'), reporte('a2', 'h1'), reporte('a3', 'h1'),
      reporte('b1', 'h2'), reporte('b2', 'h2'),
      reporte('r1', null), reporte('r2', null),
    ];

    it('agrupamiento perfecto: precisión, recall y ARI en 1, sin errores', () => {
      const asignacion = new Map([['a1', 'i1'], ['a2', 'i1'], ['a3', 'i1'], ['b1', 'i2'], ['b2', 'i2']]);
      const metricas = evaluar(reportes, asignacion);

      expect(metricas).toMatchObject({
        precision: 1,
        recall: 1,
        ari: 1,
        hechos: 2,
        hechosDetectados: 2,
        hechosPartidos: 0,
        incidentes: 2,
        fusiones: 0,
        incidentesFalsos: 0,
        ruidoAgrupado: 0,
      });
    });

    it('cuenta fusiones, hechos partidos, incidentes falsos y ruido agrupado', () => {
      const asignacion = new Map([
        ['a1', 'i1'], ['a2', 'i1'], ['b1', 'i1'], // fusión de h1 y h2
        ['a3', 'i2'], ['r1', 'i2'], // h1 partido + incidente falso con ruido
      ]);
      const metricas = evaluar(reportes, asignacion);

      // Pares que el job juntó: i1 = 3 (a1-a2 bien, a1-b1 y a2-b1 mal), i2 = 1 (mal).
      expect(metricas.precision).toBeCloseTo(1 / 4);
      // Pares verdaderos: h1 = 3, h2 = 1; el job acertó solo a1-a2.
      expect(metricas.recall).toBeCloseTo(1 / 4);
      expect(metricas).toMatchObject({
        hechosDetectados: 1,
        hechosPartidos: 1,
        incidentes: 2,
        fusiones: 1,
        incidentesFalsos: 1,
        ruidoAgrupado: 1,
      });
      expect(metricas.ari).toBeLessThan(0.5);
    });

    it('sin ningún incidente: recall 0 y precisión 1 por convención', () => {
      const metricas = evaluar(reportes, new Map());
      expect(metricas.recall).toBe(0);
      expect(metricas.precision).toBe(1);
      expect(metricas.hechosDetectados).toBe(0);
    });
  });

  describe('simularJob', () => {
    it('con la semilla fija y los defaults da siempre el mismo resultado, y razonable', async () => {
      const dataset = generarDataset({ ...ESCENARIOS.normal, semilla: SEMILLA });
      const primera = await simularJob(dataset, DEFAULTS_ACTUALES);
      const segunda = await simularJob(dataset, DEFAULTS_ACTUALES);

      expect(evaluar(dataset, segunda.incidentePorEmergencia)).toEqual(evaluar(dataset, primera.incidentePorEmergencia));

      // Umbrales holgados: es una sola réplica (el documento promedia 20).
      const metricas = evaluar(dataset, primera.incidentePorEmergencia);
      expect(metricas.precision).toBeGreaterThan(0.6);
      expect(metricas.recall).toBeGreaterThan(0.8);
      expect(metricas.hechosDetectados / metricas.hechos).toBeGreaterThan(0.9);

      const algoritmos = new Set([...primera.incidentes.values()].map((i) => i.algorithmVersion));
      expect(algoritmos).toEqual(new Set(['dbscan-v1']));
    });

    it('restaura Date.now al terminar', async () => {
      const dateNow = Date.now;
      await simularJob(generarDataset({ semilla: SEMILLA, hechos: 2, ruido: 2 }), DEFAULTS_ACTUALES);
      expect(Date.now).toBe(dateNow);
    });

    it('con una ventana más corta que la demora entre reportes, no los junta', async () => {
      const base = { emergencyType: 'MEDICA', severity: 'high', latitude: -34.6037, longitude: -58.3816, hechoId: 'h1' };
      const dataset = [
        { ...base, id: 'e1', userId: 'u1', createdAtMs: INICIO_MS },
        { ...base, id: 'e2', userId: 'u2', createdAtMs: INICIO_MS + 7 * 60000, latitude: -34.6033 },
      ];

      const corta = await simularJob(dataset, { ...DEFAULTS_ACTUALES, windowMinutes: 5 });
      const actual = await simularJob(dataset, DEFAULTS_ACTUALES);

      expect(corta.incidentes.size).toBe(0);
      expect(actual.incidentes.size).toBe(1);
    });
  });

  describe('compararConFallback', () => {
    it('con los defaults, DBSCAN y RuleBasedGrouper arman los mismos grupos', () => {
      const dataset = generarDataset({ ...ESCENARIOS.normal, semilla: SEMILLA });
      const { ventanas, distintas } = compararConFallback(dataset, DEFAULTS_ACTUALES);

      expect(ventanas).toBeGreaterThan(0);
      expect(distintas).toBe(0);
    });
  });

  describe('resumirEntreEscenarios', () => {
    it('ordena por el ARI del peor escenario', () => {
      const fila = (radiusMeters, ari) => ({
        radiusMeters, minUniqueCitizens: 2, windowMinutes: 15, ari, hechos: 10, hechosDetectados: 9,
      });
      const resumen = resumirEntreEscenarios({
        normal: [fila(200, 0.95), fila(300, 0.90)],
        gpsPobre: [fila(200, 0.70), fila(300, 0.85)],
      });

      expect(resumen.map((r) => r.radiusMeters)).toEqual([300, 200]);
      expect(resumen[0].ariMinimo).toBeCloseTo(0.85);
      expect(resumen[0].porEscenario.normal).toEqual({ ari: 0.90, detectados: 0.9 });
    });
  });
});
