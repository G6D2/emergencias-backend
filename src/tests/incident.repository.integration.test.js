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
});
