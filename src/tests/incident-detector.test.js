const { processEmergencyTypeCandidates } = require('../domain/incident-detector');
const { SEVERITY_LEVELS } = require('../domain/severity');

const BASE_LATITUDE = -34.6037;
const BASE_LONGITUDE = -58.3816;

function closeCandidate(overrides = {}) {
  return {
    id: 'default-id',
    correlationId: 'default-id',
    userId: 'default-user',
    latitude: BASE_LATITUDE,
    longitude: BASE_LONGITUDE,
    createdAt: new Date(),
    severity: 'low',
    incidentId: null,
    ...overrides,
  };
}

function farCandidate(overrides = {}) {
  return closeCandidate({
    latitude: BASE_LATITUDE + 1,
    longitude: BASE_LONGITUDE + 1,
    ...overrides,
  });
}

const DEFAULT_OPTIONS = { radiusMeters: 300, minUniqueCitizens: 2, emergencyType: 'INCENDIO' };

describe('incident-detector', () => {
  describe('processEmergencyTypeCandidates', () => {
    it('un grupo nuevo (ningun miembro con incidentId) genera una decision con incidentId null', async () => {
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1' }),
        closeCandidate({ id: 'e2', correlationId: 'e2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002 }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, DEFAULT_OPTIONS);

      expect(decisions).toHaveLength(1);
      expect(decisions[0].incidentId).toBeNull();
      expect(decisions[0].skippedReason).toBeNull();
      expect(decisions[0].members).toHaveLength(2);
      expect(decisions[0].members.map((m) => m.emergencyId).sort()).toEqual(['e1', 'e2']);
    });

    it('un grupo donde todos los miembros ya comparten el mismo incidentId genera una decision con ese incidentId', async () => {
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1', incidentId: 'inc-1' }),
        closeCandidate({
          id: 'e2',
          correlationId: 'e2',
          userId: 'u2',
          latitude: BASE_LATITUDE + 0.0002,
          incidentId: 'inc-1',
        }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, DEFAULT_OPTIONS);

      expect(decisions).toHaveLength(1);
      expect(decisions[0].incidentId).toBe('inc-1');
      expect(decisions[0].skippedReason).toBeNull();
      expect(decisions[0].members.every((m) => m.alreadyLinked)).toBe(true);
    });

    it('un grupo con miembros de DOS incidentId existentes distintos se marca AMBIGUOUS_EXISTING_INCIDENTS sin members para actuar', async () => {
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1', incidentId: 'inc-1' }),
        closeCandidate({
          id: 'e2',
          correlationId: 'e2',
          userId: 'u2',
          latitude: BASE_LATITUDE + 0.0002,
          incidentId: 'inc-2',
        }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, DEFAULT_OPTIONS);

      expect(decisions).toHaveLength(1);
      expect(decisions[0].skippedReason).toBe('AMBIGUOUS_EXISTING_INCIDENTS');
      expect(decisions[0].members).toEqual([]);
      expect(decisions[0].conflictingIncidentIds.sort()).toEqual(['inc-1', 'inc-2']);
    });

    it('el finalPriority de cada member nunca es menor al priorityIndividual de esa emergencia', async () => {
      // Grupo disperso en el tiempo y de severity mayormente baja: el score del
      // incidente da bajo, pero un miembro individualmente 'critical' no puede
      // bajar de esa prioridad por el invariante de risk-engine.
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1', severity: 'critical', createdAt: longAgo }),
        closeCandidate({
          id: 'e2',
          correlationId: 'e2',
          userId: 'u2',
          severity: 'low',
          createdAt: longAgo,
          latitude: BASE_LATITUDE + 0.0002,
        }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, DEFAULT_OPTIONS);

      expect(decisions).toHaveLength(1);
      decisions[0].members.forEach((member) => {
        const individualIndex = SEVERITY_LEVELS.indexOf(member.priorityIndividual);
        const finalIndex = SEVERITY_LEVELS.indexOf(member.finalPriority);
        expect(finalIndex).toBeGreaterThanOrEqual(individualIndex);
      });

      const criticalMember = decisions[0].members.find((m) => m.emergencyId === 'e1');
      expect(criticalMember.finalPriority).toBe('critical');
    });

    it('con minUniqueCitizens=1, una emergencia sola forma un grupo de un miembro (sin pares para calcular distancia)', async () => {
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1', severity: 'medium' }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, { ...DEFAULT_OPTIONS, minUniqueCitizens: 1 });

      expect(decisions).toHaveLength(1);
      expect(decisions[0].members).toHaveLength(1);
      expect(decisions[0].factors.reportCount).toBe(1);
      expect(decisions[0].factors.minDistanceMeters).toBe(0);
      expect(decisions[0].factors.maxDistanceMeters).toBe(0);
      expect(decisions[0].factors.maxSeverity).toBe('medium');
    });

    it('la severity máxima del grupo puede estar en un miembro que no es el primero', async () => {
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1', severity: 'low' }),
        closeCandidate({
          id: 'e2', correlationId: 'e2', userId: 'u2', severity: 'critical', latitude: BASE_LATITUDE + 0.0002,
        }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, DEFAULT_OPTIONS);

      expect(decisions).toHaveLength(1);
      expect(decisions[0].factors.maxSeverity).toBe('critical');
    });

    it('una emergencia sola, sin nadie mas cerca, no genera ninguna decision', async () => {
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1' }),
        farCandidate({ id: 'e2', correlationId: 'e2', userId: 'u2' }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, DEFAULT_OPTIONS);

      expect(decisions).toEqual([]);
    });

    it('candidatos validos: DBSCAN corre normal como estrategia primaria y algorithmVersion es dbscan-v1', async () => {
      const candidates = [
        closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1' }),
        closeCandidate({ id: 'e2', correlationId: 'e2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002 }),
      ];

      const decisions = await processEmergencyTypeCandidates(candidates, DEFAULT_OPTIONS);

      expect(decisions).toHaveLength(1);
      expect(decisions[0].algorithmVersion).toBe('dbscan-v1');
    });

    describe('incidente existente con miembros que ya salieron de la ventana (calibración DBSCAN)', () => {
      // Caso de la demo: tres ciudadanos, DISTURBIO_EVENTO_MASIVO (medium), a
      // menos de 71 m entre sí, en t = 0, 30 s y 60 s. Ahora es t = 15,5 min:
      // e1 ya salió de la ventana de 15 min y el job solo ve a e2 y e3.
      const MINUTE = 60000;
      const minutesAgo = (minutes) => new Date(Date.now() - minutes * MINUTE);
      const demo = {
        e1: closeCandidate({
          id: 'e1', correlationId: 'e1', userId: 'u1', severity: 'medium', incidentId: 'inc-1', createdAt: minutesAgo(15.5),
        }),
        e2: closeCandidate({
          id: 'e2',
          correlationId: 'e2',
          userId: 'u2',
          severity: 'medium',
          incidentId: 'inc-1',
          createdAt: minutesAgo(15),
          latitude: -34.6033,
        }),
        e3: closeCandidate({
          id: 'e3',
          correlationId: 'e3',
          userId: 'u3',
          severity: 'medium',
          incidentId: 'inc-1',
          createdAt: minutesAgo(14.5),
          longitude: -58.3810,
        }),
      };
      const OPTIONS = { ...DEFAULT_OPTIONS, emergencyType: 'DISTURBIO_EVENTO_MASIVO' };

      it('puntúa con todos los miembros activos del incidente: el score y la prioridad no bajan', async () => {
        const soloVentana = await processEmergencyTypeCandidates([demo.e2, demo.e3], OPTIONS);
        const conTodos = await processEmergencyTypeCandidates([demo.e2, demo.e3], {
          ...OPTIONS,
          incidentMembers: [demo.e1, demo.e2, demo.e3],
        });

        // Sin los miembros del incidente (el comportamiento viejo) el score
        // cae a ~42 y la prioridad vuelve a medium.
        expect(soloVentana[0].factors.reportCount).toBe(2);
        expect(soloVentana[0].priority).toBe('medium');

        expect(conTodos).toHaveLength(1);
        expect(conTodos[0].incidentId).toBe('inc-1');
        expect(conTodos[0].factors.reportCount).toBe(3);
        expect(conTodos[0].factors.uniqueCitizenCount).toBe(3);
        expect(conTodos[0].reasonCodes).toContain('MULTI_REPORT_THRESHOLD');
        expect(conTodos[0].score).toBeGreaterThanOrEqual(50);
        expect(conTodos[0].priority).toBe('high');
      });

      it('el miembro fuera de la ventana queda en la decisión como ya vinculado, con su finalPriority', async () => {
        const [decision] = await processEmergencyTypeCandidates([demo.e2, demo.e3], {
          ...OPTIONS,
          incidentMembers: [demo.e1, demo.e2, demo.e3],
        });

        expect(decision.members.map((m) => m.emergencyId).sort()).toEqual(['e1', 'e2', 'e3']);
        decision.members.forEach((member) => {
          expect(member.alreadyLinked).toBe(true);
          expect(member.finalPriority).toBe('high');
        });
      });

      it('la recencia sale del reporte más nuevo, no del que salió de la ventana', async () => {
        const [decision] = await processEmergencyTypeCandidates([demo.e2, demo.e3], {
          ...OPTIONS,
          incidentMembers: [demo.e1],
        });

        expect(decision.factors.recencyMinutes).toBeCloseTo(14.5, 1);
      });

      it('no suma miembros de otro incidente ni a un grupo nuevo', async () => {
        const otroIncidente = closeCandidate({
          id: 'x1', correlationId: 'x1', userId: 'u9', severity: 'medium', incidentId: 'inc-2', createdAt: minutesAgo(20),
        });

        const [existente] = await processEmergencyTypeCandidates([demo.e2, demo.e3], {
          ...OPTIONS,
          incidentMembers: [otroIncidente, demo.e1],
        });
        expect(existente.members.map((m) => m.emergencyId).sort()).toEqual(['e1', 'e2', 'e3']);

        const nuevos = [
          closeCandidate({ id: 'n1', correlationId: 'n1', userId: 'u1' }),
          closeCandidate({ id: 'n2', correlationId: 'n2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002 }),
        ];
        const [nuevo] = await processEmergencyTypeCandidates(nuevos, { ...OPTIONS, incidentMembers: [otroIncidente] });
        expect(nuevo.incidentId).toBeNull();
        expect(nuevo.members.map((m) => m.emergencyId).sort()).toEqual(['n1', 'n2']);
      });

      it('un miembro sin ubicación cuenta como reporte, pero no entra en las distancias', async () => {
        const sinUbicacion = { ...demo.e1, latitude: null, longitude: null };

        const [decision] = await processEmergencyTypeCandidates([demo.e2, demo.e3], {
          ...OPTIONS,
          incidentMembers: [sinUbicacion],
        });

        expect(decision.factors.reportCount).toBe(3);
        // e2–e3 están a ~71 m; con (0, 0) la distancia máxima serían miles de km.
        expect(decision.factors.maxDistanceMeters).toBeGreaterThan(60);
        expect(decision.factors.maxDistanceMeters).toBeLessThan(80);
        expect(decision.reasonCodes).toContain('PROXIMITY_CLUSTER');
      });
    });

    // DBSCAN falla en runtime (excepcion tecnica real de la libreria, no un
    // resultado vacio): se usa RuleBasedGrouper real -- sin mockear -- y el
    // resultado debe tener algorithmVersion 'rule-based-v1'. No existe un
    // array de candidatos con lat/lng invalidos que rompa solo a DBSCAN sin
    // romper tambien a RuleBasedGrouper (ambas comparten haversineDistance
    // Meters sin validar, ver LIMITACION CONOCIDA en dbscan-grouper.js) --
    // confirmado empiricamente antes de escribir este test. Por eso mockeamos
    // puntualmente el modulo dbscan-grouper (solo en este test, via
    // jest.doMock + jest.resetModules) para forzar la falla de la primaria;
    // RuleBasedGrouper sigue siendo codigo real, sin mockear. Esto prueba el
    // WIRING real de incident-detector.js (las constantes de version quedan
    // bien conectadas), no el mecanismo abstracto de conmutacion en si, que
    // ya esta cubierto con fakes en incident-detection-strategy.test.js.
    it('DBSCAN falla tecnicamente en runtime: se usa RuleBasedGrouper real (sin mock) y algorithmVersion es rule-based-v1', async () => {
      jest.resetModules();
      jest.doMock('../domain/dbscan-grouper', () => ({
        groupNearbyEmergenciesDbscan: jest.fn(() => {
          throw new Error('fallo simulado de DBSCAN');
        }),
      }));

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const { processEmergencyTypeCandidates: processWithBrokenDbscan } = require('../domain/incident-detector');

        const candidates = [
          closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1' }),
          closeCandidate({ id: 'e2', correlationId: 'e2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002 }),
        ];

        const decisions = await processWithBrokenDbscan(candidates, DEFAULT_OPTIONS);

        expect(decisions).toHaveLength(1);
        expect(decisions[0].algorithmVersion).toBe('rule-based-v1');
        expect(decisions[0].members.map((m) => m.emergencyId).sort()).toEqual(['e1', 'e2']);
      } finally {
        consoleWarnSpy.mockRestore();
        jest.dontMock('../domain/dbscan-grouper');
        jest.resetModules();
      }
    });
  });
});
