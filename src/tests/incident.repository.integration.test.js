const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { IncidentRepository } = require('../repositories/incident.repository');

describe('IncidentRepository (integración contra Postgres real)', () => {
  let emergencyRepository;
  let incidentRepository;

  beforeAll(() => {
    process.env.LOCATION_ENCRYPTION_KEY =
      process.env.LOCATION_ENCRYPTION_KEY
      || 'flxqyJtbe6+mibyHqK76N6LSnFe0w22hnyDZg9KWIcs=';
    emergencyRepository = new EmergencyRepository(getPool());
    incidentRepository = new IncidentRepository(getPool(), emergencyRepository);
  });

  afterAll(async () => {
    await closePool();
  });

  function buildEmergency(overrides = {}) {
    return {
      id: randomUUID(),
      userId: 'user-123',
      latitude: -34.6037,
      longitude: -58.3816,
      description: 'Test panic button',
      severity: 'critical',
      ...overrides,
    };
  }

  it('IncidentRepository.create() inserta y el resultado tiene un id UUID', async () => {
    const incident = await incidentRepository.create({
      emergencyType: 'INCENDIO',
      priority: 'alta',
      score: 0.87,
      reasonCodes: ['multiple-callers'],
      algorithmVersion: 'v1',
    });

    expect(incident.id).toEqual(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    );
    expect(incident.emergencyType).toBe('INCENDIO');
    expect(incident.priority).toBe('alta');
    expect(incident.algorithmVersion).toBe('v1');
  });

  it('insertar en emergencies un incident_id que no existe en incidents falla por la FK', async () => {
    const badIncidentId = randomUUID();

    await expect(getPool().query(
      `INSERT INTO emergencies (id, user_id, description, severity, status, incident_id)
       VALUES ($1, 'user-fk', 'fk inválida', 'high', 'PENDING', $2)`,
      [randomUUID(), badIncidentId]
    )).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
  });

  it('EmergencyRepository.setIncidentId() asigna correctamente y findById() devuelve el incidentId', async () => {
    const incident = await incidentRepository.create({ emergencyType: 'MEDICA' });
    const input = buildEmergency();
    await emergencyRepository.create(input);

    const updated = await emergencyRepository.setIncidentId(input.id, incident.id);
    expect(updated.incidentId).toBe(incident.id);

    const found = await emergencyRepository.findById(input.id);
    expect(found.incidentId).toBe(incident.id);
  });

  it('dos emergencias distintas pueden compartir el mismo incident_id sin error', async () => {
    const incident = await incidentRepository.create({ emergencyType: 'OTRO' });
    const first = buildEmergency();
    const second = buildEmergency();
    await emergencyRepository.create(first);
    await emergencyRepository.create(second);

    await emergencyRepository.setIncidentId(first.id, incident.id);
    await emergencyRepository.setIncidentId(second.id, incident.id);

    const foundFirst = await emergencyRepository.findById(first.id);
    const foundSecond = await emergencyRepository.findById(second.id);
    expect(foundFirst.incidentId).toBe(incident.id);
    expect(foundSecond.incidentId).toBe(incident.id);
  });

  it('findActive() devuelve un incidente con una emergencia miembro PENDING y no uno cuyas emergencias están todas CLOSED', async () => {
    const activeIncident = await incidentRepository.create({ emergencyType: 'PANICO' });
    const pendingEmergency = buildEmergency();
    await emergencyRepository.create(pendingEmergency);
    await emergencyRepository.setIncidentId(pendingEmergency.id, activeIncident.id);

    const closedIncident = await incidentRepository.create({ emergencyType: 'PANICO' });
    const closedEmergency = buildEmergency({ status: 'CLOSED' });
    await emergencyRepository.create(closedEmergency);
    await emergencyRepository.setIncidentId(closedEmergency.id, closedIncident.id);

    const active = await incidentRepository.findActive();

    expect(active.some((row) => row.id === activeIncident.id)).toBe(true);
    expect(active.some((row) => row.id === closedIncident.id)).toBe(false);
  });

  describe('updateScoring', () => {
    it('actualiza priority/score/reasonCodes/factors/algorithmVersion y son recuperables despues', async () => {
      const incident = await incidentRepository.create({ emergencyType: 'INCENDIO' });

      const updated = await incidentRepository.updateScoring(incident.id, {
        priority: 'alta',
        score: 0.93,
        reasonCodes: ['multiple-callers', 'high-density'],
        factors: { proximityScore: 0.8, timeWindowMinutes: 15 },
        algorithmVersion: 'rule-based-v1',
      });

      expect(updated.priority).toBe('alta');
      expect(Number(updated.score)).toBeCloseTo(0.93);
      expect(updated.reasonCodes).toEqual(['multiple-callers', 'high-density']);
      expect(updated.factors).toEqual({ proximityScore: 0.8, timeWindowMinutes: 15 });
      expect(updated.algorithmVersion).toBe('rule-based-v1');

      const raw = await getPool().query(
        'SELECT priority, score, reason_codes, factors, algorithm_version FROM incidents WHERE id = $1',
        [incident.id]
      );
      expect(raw.rows[0].priority).toBe('alta');
      expect(Number(raw.rows[0].score)).toBeCloseTo(0.93);
      expect(raw.rows[0].reason_codes).toEqual(['multiple-callers', 'high-density']);
      expect(raw.rows[0].factors).toEqual({ proximityScore: 0.8, timeWindowMinutes: 15 });
      expect(raw.rows[0].algorithm_version).toBe('rule-based-v1');
    });

    it('lanza NotFoundError si el incidentId no existe', async () => {
      const missingId = randomUUID();

      await expect(incidentRepository.updateScoring(missingId, {
        priority: 'alta',
        score: 0.5,
        reasonCodes: [],
        factors: {},
        algorithmVersion: 'rule-based-v1',
      })).rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
    });
  });

  describe('applyScoringDecision', () => {
    async function buildLinkedPair(incidentId) {
      const first = buildEmergency();
      const second = buildEmergency();
      await emergencyRepository.create(first);
      await emergencyRepository.create(second);
      await emergencyRepository.setIncidentId(first.id, incidentId);
      await emergencyRepository.setIncidentId(second.id, incidentId);
      return [first, second];
    }

    async function prioritizedEventsFor(incidentId) {
      const result = await getPool().query(
        `SELECT payload FROM outbox_events WHERE topic = 'emergencias.priorizada'`
      );
      return result.rows
        .map((row) => row.payload)
        .filter((payload) => payload.data.incidentId === incidentId);
    }

    it('primera vez (priority NULL): persiste los campos y genera un evento en outbox por member', async () => {
      const incident = await incidentRepository.create({ emergencyType: 'INCENDIO' });
      const [first, second] = await buildLinkedPair(incident.id);

      const members = [
        { emergencyId: first.id, correlationId: first.id, priorityIndividual: 'high', finalPriority: 'high' },
        { emergencyId: second.id, correlationId: second.id, priorityIndividual: 'low', finalPriority: 'high' },
      ];

      const updated = await incidentRepository.applyScoringDecision(incident.id, {
        priority: 'high',
        score: 62,
        reasonCodes: ['PROXIMITY_CLUSTER'],
        factors: { reportCount: 2, maxSeverity: 'high' },
        algorithmVersion: 'rule-based-v1',
        members,
      });

      expect(updated.priority).toBe('high');

      const raw = await getPool().query(
        'SELECT priority, score, reason_codes, factors, algorithm_version FROM incidents WHERE id = $1',
        [incident.id]
      );
      expect(raw.rows[0].priority).toBe('high');
      expect(Number(raw.rows[0].score)).toBeCloseTo(62);
      expect(raw.rows[0].reason_codes).toEqual(['PROXIMITY_CLUSTER']);
      expect(raw.rows[0].factors).toEqual({ reportCount: 2, maxSeverity: 'high' });
      expect(raw.rows[0].algorithm_version).toBe('rule-based-v1');

      const events = await prioritizedEventsFor(incident.id);
      expect(events).toHaveLength(2);

      const byEmergencyId = new Map(events.map((event) => [event.data.id, event]));
      expect(byEmergencyId.get(first.id).data.correlationId).toBe(first.id);
      expect(byEmergencyId.get(first.id).data.incidentId).toBe(incident.id);
      expect(byEmergencyId.get(first.id).data.priorityIndividual).toBe('high');
      expect(byEmergencyId.get(first.id).data.incidentPriority).toBe('high');
      expect(byEmergencyId.get(second.id).data.priorityIndividual).toBe('low');
      expect(byEmergencyId.get(second.id).data.incidentPriority).toBe('high');
    });

    it('corrida repetida sin cambio de prioridad actualiza los demas campos pero no genera eventos nuevos', async () => {
      const incident = await incidentRepository.create({ emergencyType: 'INCENDIO' });
      const [first, second] = await buildLinkedPair(incident.id);
      const members = [
        { emergencyId: first.id, correlationId: first.id, priorityIndividual: 'medium', finalPriority: 'medium' },
        { emergencyId: second.id, correlationId: second.id, priorityIndividual: 'medium', finalPriority: 'medium' },
      ];

      await incidentRepository.applyScoringDecision(incident.id, {
        priority: 'medium',
        score: 40,
        reasonCodes: ['PROXIMITY_CLUSTER'],
        factors: { reportCount: 2 },
        algorithmVersion: 'rule-based-v1',
        members,
      });

      const eventsBefore = await prioritizedEventsFor(incident.id);
      expect(eventsBefore).toHaveLength(2);

      const updated = await incidentRepository.applyScoringDecision(incident.id, {
        priority: 'medium',
        score: 45,
        reasonCodes: ['PROXIMITY_CLUSTER', 'MULTI_REPORT_THRESHOLD'],
        factors: { reportCount: 3 },
        algorithmVersion: 'rule-based-v1',
        members,
      });

      expect(updated.priority).toBe('medium');
      expect(Number(updated.score)).toBeCloseTo(45);
      expect(updated.reasonCodes).toEqual(['PROXIMITY_CLUSTER', 'MULTI_REPORT_THRESHOLD']);

      const eventsAfter = await prioritizedEventsFor(incident.id);
      expect(eventsAfter).toHaveLength(eventsBefore.length);
    });

    it('corrida con cambio real de prioridad (medium -> high) genera eventos nuevos, uno por member', async () => {
      const incident = await incidentRepository.create({ emergencyType: 'INCENDIO' });
      const [first, second] = await buildLinkedPair(incident.id);
      const members = [
        { emergencyId: first.id, correlationId: first.id, priorityIndividual: 'medium', finalPriority: 'medium' },
        { emergencyId: second.id, correlationId: second.id, priorityIndividual: 'medium', finalPriority: 'medium' },
      ];

      await incidentRepository.applyScoringDecision(incident.id, {
        priority: 'medium',
        score: 40,
        reasonCodes: [],
        factors: {},
        algorithmVersion: 'rule-based-v1',
        members,
      });
      expect(await prioritizedEventsFor(incident.id)).toHaveLength(2);

      const escalatedMembers = [
        { emergencyId: first.id, correlationId: first.id, priorityIndividual: 'medium', finalPriority: 'high' },
        { emergencyId: second.id, correlationId: second.id, priorityIndividual: 'medium', finalPriority: 'high' },
      ];

      const updated = await incidentRepository.applyScoringDecision(incident.id, {
        priority: 'high',
        score: 70,
        reasonCodes: ['PROXIMITY_CLUSTER'],
        factors: { reportCount: 3 },
        algorithmVersion: 'rule-based-v1',
        members: escalatedMembers,
      });

      expect(updated.priority).toBe('high');

      const eventsAfterSecondRun = await prioritizedEventsFor(incident.id);
      expect(eventsAfterSecondRun).toHaveLength(4);

      const highPriorityEvents = eventsAfterSecondRun.filter((event) => event.data.incidentPriority === 'high');
      expect(highPriorityEvents).toHaveLength(2);
    });

    it('lanza NotFoundError si el incidentId no existe', async () => {
      const missingId = randomUUID();

      await expect(incidentRepository.applyScoringDecision(missingId, {
        priority: 'high',
        score: 70,
        reasonCodes: [],
        factors: {},
        algorithmVersion: 'rule-based-v1',
        members: [],
      })).rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
    });
  });
});
