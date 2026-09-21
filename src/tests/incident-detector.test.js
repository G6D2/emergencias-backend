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
  });
});
