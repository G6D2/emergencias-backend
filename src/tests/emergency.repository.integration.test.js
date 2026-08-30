const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');

describe('EmergencyRepository (integración contra Postgres real)', () => {
  let repository;

  beforeAll(() => {
    process.env.LOCATION_ENCRYPTION_KEY =
      process.env.LOCATION_ENCRYPTION_KEY
      || 'flxqyJtbe6+mibyHqK76N6LSnFe0w22hnyDZg9KWIcs=';
    repository = new EmergencyRepository(getPool());
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

  it('crea una emergencia con estado inicial CREATED', async () => {
    const input = buildEmergency();

    const created = await repository.create(input);

    expect(created.id).toBe(input.id);
    expect(created.userId).toBe(input.userId);
    expect(created.status).toBe('CREATED');
    expect(Number(created.latitude)).toBeCloseTo(input.latitude);
    expect(Number(created.longitude)).toBeCloseTo(input.longitude);
    expect(created.locationAnonymized).toBe(false);
    expect(created.createdAt).toBeDefined();
  });

  it('persiste ubicación cifrada (sin lat/lng en claro en la fila)', async () => {
    const input = buildEmergency();
    await repository.create(input);

    const raw = await getPool().query(
      'SELECT latitude, longitude, location_encrypted FROM emergencies WHERE id = $1',
      [input.id]
    );
    const row = raw.rows[0];
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
    expect(row.location_encrypted).toBeTruthy();
    expect(row.location_encrypted).not.toContain(String(input.latitude));
  });

  it('busca una emergencia por id', async () => {
    const input = buildEmergency();
    await repository.create(input);

    const found = await repository.findById(input.id);

    expect(found).not.toBeNull();
    expect(found.id).toBe(input.id);
    expect(found.description).toBe(input.description);
  });

  it('devuelve null si el id no existe', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('lista emergencias existentes', async () => {
    const input = buildEmergency();
    await repository.create(input);

    const all = await repository.findAll();

    expect(Array.isArray(all)).toBe(true);
    expect(all.some((emergency) => emergency.id === input.id)).toBe(true);
  });

  it('actualiza el estado y registra el historial de forma atómica', async () => {
    const input = buildEmergency();
    await repository.create(input);

    const { emergency, history } = await repository.updateStatus(input.id, {
      newStatus: 'VALIDATED',
      actor: 'operador-1',
      reason: 'Confirmado por operador',
    });

    expect(emergency.status).toBe('VALIDATED');
    expect(history.previousStatus).toBe('CREATED');
    expect(history.newStatus).toBe('VALIDATED');
    expect(history.actor).toBe('operador-1');
    expect(history.reason).toBe('Confirmado por operador');

    const historyList = await repository.findHistoryByEmergencyId(input.id);
    expect(historyList).toHaveLength(1);
  });

  it('propaga el error y no deja rastros si la emergencia no existe', async () => {
    const missingId = randomUUID();

    await expect(repository.updateStatus(missingId, { newStatus: 'VALIDATED' })).rejects.toThrow();

    const historyList = await repository.findHistoryByEmergencyId(missingId);
    expect(historyList).toHaveLength(0);
  });

  it('registra auditoría de acceso y anonimiza ubicaciones vencidas', async () => {
    const input = buildEmergency();
    await repository.create(input);

    await repository.recordAccess({
      emergencyId: input.id,
      actorSub: 'U000999',
      action: 'emergency:read',
    });

    const audit = await repository.findAccessAuditByEmergencyId(input.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].actorSub).toBe('U000999');

    await getPool().query(
      `UPDATE emergencies SET created_at = now() - interval '100 hours' WHERE id = $1`,
      [input.id]
    );

    const result = await repository.anonymizeExpiredLocations(72);
    expect(result.ids).toContain(input.id);

    const found = await repository.findById(input.id);
    expect(found.latitude).toBeNull();
    expect(found.longitude).toBeNull();
    expect(found.locationAnonymized).toBe(true);
  });

  it('hace ROLLBACK si el cambio de estado viola una restricción de la base', async () => {
    const input = buildEmergency();
    await repository.create(input);

    await expect(repository.updateStatus(input.id, { newStatus: null })).rejects.toThrow();

    const found = await repository.findById(input.id);
    expect(found.status).toBe('CREATED');

    const historyList = await repository.findHistoryByEmergencyId(input.id);
    expect(historyList).toHaveLength(0);
  });
});
