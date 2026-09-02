const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');

describe('EmergencyRepository (integración contra Postgres real)', () => {
  let repository;

  beforeAll(() => {
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

  it('crea una emergencia con estado inicial PENDING', async () => {
    const input = buildEmergency();

    const created = await repository.create(input);

    expect(created.id).toBe(input.id);
    expect(created.userId).toBe(input.userId);
    expect(created.status).toBe('PENDING');
    expect(Number(created.latitude)).toBeCloseTo(input.latitude);
    expect(Number(created.longitude)).toBeCloseTo(input.longitude);
    expect(created.createdAt).toBeDefined();
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
    expect(history.previousStatus).toBe('PENDING');
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

  it('hace ROLLBACK si el cambio de estado viola una restricción de la base', async () => {
    const input = buildEmergency();
    await repository.create(input);

    await expect(repository.updateStatus(input.id, { newStatus: null })).rejects.toThrow();

    const found = await repository.findById(input.id);
    expect(found.status).toBe('PENDING');

    const historyList = await repository.findHistoryByEmergencyId(input.id);
    expect(historyList).toHaveLength(0);
  });
});
