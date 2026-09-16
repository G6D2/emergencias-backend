const {
  PRIORITY_LEVELS,
  calculateIncidentScore,
  scoreToPriority,
  applyPriorityInvariant,
} = require('../domain/risk-engine');

function baseInput(overrides = {}) {
  return {
    reportCount: 1,
    uniqueCitizenCount: 1,
    minDistanceMeters: 500,
    maxDistanceMeters: 500,
    recencyMinutes: 60,
    maxSeverity: 'low',
    ...overrides,
  };
}

describe('risk-engine', () => {
  describe('calculateIncidentScore', () => {
    it('da un score mayor cuantos más reportes haya', () => {
      const base = calculateIncidentScore(baseInput());
      const moreReports = calculateIncidentScore(baseInput({ reportCount: 5 }));

      expect(moreReports.score).toBeGreaterThan(base.score);
    });

    it('da un score mayor cuantos más usuarios únicos haya', () => {
      const base = calculateIncidentScore(baseInput());
      const moreCitizens = calculateIncidentScore(baseInput({ uniqueCitizenCount: 5 }));

      expect(moreCitizens.score).toBeGreaterThan(base.score);
    });

    it('da un score mayor cuanto más cerca estén los reportes entre sí', () => {
      const base = calculateIncidentScore(baseInput());
      const closer = calculateIncidentScore(baseInput({ minDistanceMeters: 10, maxDistanceMeters: 10 }));

      expect(closer.score).toBeGreaterThan(base.score);
    });

    it('da un score mayor cuanto más reciente sea el reporte', () => {
      const base = calculateIncidentScore(baseInput());
      const moreRecent = calculateIncidentScore(baseInput({ recencyMinutes: 1 }));

      expect(moreRecent.score).toBeGreaterThan(base.score);
    });

    it('agrega MULTI_REPORT_THRESHOLD cuando el conteo de reportes lo justifica', () => {
      const { reasonCodes } = calculateIncidentScore(baseInput({ reportCount: 10 }));
      expect(reasonCodes).toContain('MULTI_REPORT_THRESHOLD');
    });

    it('agrega UNIQUE_CITIZENS_THRESHOLD cuando hay suficientes ciudadanos distintos', () => {
      const { reasonCodes } = calculateIncidentScore(baseInput({ uniqueCitizenCount: 4 }));
      expect(reasonCodes).toContain('UNIQUE_CITIZENS_THRESHOLD');
    });

    it('agrega PROXIMITY_CLUSTER cuando los reportes están cerca entre sí', () => {
      const { reasonCodes } = calculateIncidentScore(baseInput({ minDistanceMeters: 20, maxDistanceMeters: 20 }));
      expect(reasonCodes).toContain('PROXIMITY_CLUSTER');
    });

    it('no agrega ningún reasonCode cuando ningún factor supera su umbral', () => {
      const { reasonCodes } = calculateIncidentScore(baseInput());
      expect(reasonCodes).toEqual([]);
    });
  });

  describe('scoreToPriority', () => {
    it('nunca devuelve algo fuera de PRIORITY_LEVELS', () => {
      const scores = [-1000, -1, 0, 1, 20, 49, 50, 79, 80, 150, 1000];

      scores.forEach((score) => {
        expect(PRIORITY_LEVELS).toContain(scoreToPriority(score));
      });
    });
  });

  describe('applyPriorityInvariant', () => {
    it('con las 16 combinaciones de PRIORITY_LEVELS x PRIORITY_LEVELS, nunca devuelve un índice menor al de priorityIndividual', () => {
      PRIORITY_LEVELS.forEach((priorityIndividual, indexIndividual) => {
        PRIORITY_LEVELS.forEach((incidentPriority) => {
          const result = applyPriorityInvariant(priorityIndividual, incidentPriority);
          const resultIndex = PRIORITY_LEVELS.indexOf(result);

          expect(resultIndex).toBeGreaterThanOrEqual(indexIndividual);
        });
      });
    });

    it('devuelve el más alto de los dos cuando incidentPriority es menor', () => {
      expect(applyPriorityInvariant('critical', 'low')).toBe('critical');
    });

    it('devuelve el más alto de los dos cuando incidentPriority es mayor', () => {
      expect(applyPriorityInvariant('low', 'critical')).toBe('critical');
    });

    it('lanza una excepción si priorityIndividual no está en PRIORITY_LEVELS (p. ej. la escala vieja en español del comentario TEMPORAL)', () => {
      expect(() => applyPriorityInvariant('BAJA', 'critical')).toThrow();
    });

    it('lanza una excepción si incidentPriority no está en PRIORITY_LEVELS, con priorityIndividual válido', () => {
      expect(() => applyPriorityInvariant('high', 'BOGUS')).toThrow();
    });
  });
});
