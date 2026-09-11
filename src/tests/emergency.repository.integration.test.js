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

  it('crea una emergencia con estado inicial PENDING', async () => {
    const input = buildEmergency();

    const created = await repository.create(input);

    expect(created.id).toBe(input.id);
    expect(created.userId).toBe(input.userId);
    expect(created.status).toBe('PENDING');
    expect(Number(created.latitude)).toBeCloseTo(input.latitude);
    expect(Number(created.longitude)).toBeCloseTo(input.longitude);
    expect(created.locationAnonymized).toBe(false);
    expect(created.createdAt).toBeDefined();
  });

  it('persiste emergency_type normalizado al catálogo y correlation_id = id (#44, #58)', async () => {
    const input = buildEmergency({ emergencyType: 'fire' });

    const created = await repository.create(input);

    expect(created.emergencyType).toBe('INCENDIO');
    expect(created.correlationId).toBe(input.id);

    const raw = await getPool().query(
      'SELECT emergency_type, correlation_id FROM emergencies WHERE id = $1',
      [input.id]
    );
    expect(raw.rows[0].emergency_type).toBe('INCENDIO');
    expect(raw.rows[0].correlation_id).toBe(input.id);

    const found = await repository.findById(input.id);
    expect(found.emergencyType).toBe('INCENDIO');
    expect(found.correlationId).toBe(input.id);
  });

  it('persiste emergency_type y correlation_id también en la rama con outbox', async () => {
    const input = buildEmergency({ emergencyType: 'MEDICA' });

    const created = await repository.create({
      ...input,
      outboxEvent: {
        topic: 'emergencias.boton-panico',
        payload: (emergency, eventId) => ({
          type: 'EmergenciaCreada',
          eventId,
          correlationId: emergency.correlationId,
          data: { id: emergency.id, emergencyType: emergency.emergencyType },
        }),
      },
    });

    expect(created.emergencyType).toBe('MEDICA');
    expect(created.correlationId).toBe(input.id);

    const outbox = await getPool().query(
      `SELECT payload FROM outbox_events WHERE payload->'data'->>'id' = $1 LIMIT 1`,
      [input.id]
    );
    expect(outbox.rows[0].payload.correlationId).toBe(input.id);
    expect(outbox.rows[0].payload.data.emergencyType).toBe('MEDICA');
  });

  it('el CHECK de V10 rechaza un emergency_type fuera del catálogo insertado directo', async () => {
    await expect(getPool().query(
      `INSERT INTO emergencies (id, user_id, description, severity, status, emergency_type)
       VALUES ($1, 'user-check', 'tipo inválido', 'high', 'PENDING', 'fire')`,
      [randomUUID()]
    )).rejects.toMatchObject({ code: '23514' }); // check_violation

    await expect(getPool().query(
      `INSERT INTO emergencies (id, user_id, description, severity, status, emergency_type)
       VALUES ($1, 'user-check', 'tipo inválido', 'high', 'PENDING', 'FLOOD')`,
      [randomUUID()]
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('el repository rechaza con ValidationError un emergencyType inválido antes de tocar la base', async () => {
    const input = buildEmergency({ emergencyType: 'flood' });

    await expect(repository.create(input))
      .rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });

    const found = await repository.findById(input.id);
    expect(found).toBeNull();
  });

  it('findPage filtra por emergencyType aceptando el alias del front', async () => {
    const medical = buildEmergency({ emergencyType: 'medical' });
    const fire = buildEmergency({ emergencyType: 'INCENDIO' });
    await repository.create(medical);
    await repository.create(fire);

    const { emergencies } = await repository.findPage({
      statuses: [],
      emergencyType: 'medical',
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      order: 'desc',
    });

    expect(emergencies.some((emergency) => emergency.id === medical.id)).toBe(true);
    expect(emergencies.some((emergency) => emergency.id === fire.id)).toBe(false);
    expect(emergencies.every((emergency) => emergency.emergencyType === 'MEDICA')).toBe(true);

    await expect(repository.findPage({
      statuses: [], emergencyType: 'flood', page: 1, limit: 10, sortBy: 'createdAt', order: 'desc',
    })).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('crea la emergencia y su evento outbox en la misma transacción', async () => {
    const input = buildEmergency();
    const created = await repository.create({
      ...input,
      outboxEvent: {
        topic: 'emergencias.boton-panico',
        payload: (emergency, eventId) => ({
          type: 'EmergenciaCreada',
          eventId,
          correlationId: emergency.id,
          data: { id: emergency.id, severity: emergency.severity },
        }),
      },
    });

    const outbox = await getPool().query(
      `SELECT topic, status, payload
       FROM outbox_events
       WHERE payload->'data'->>'id' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.id]
    );

    expect(created.id).toBe(input.id);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].status).toBe('PENDING');
    expect(outbox.rows[0].payload.data.id).toBe(input.id);
  });

  it('rolls back the emergency if the outbox insert fails', async () => {
    const input = buildEmergency();

    await expect(repository.create({
      ...input,
      outboxEvent: {
        topic: null,
        payload: { type: 'InvalidEvent' },
      },
    })).rejects.toThrow();

    const emergency = await repository.findById(input.id);
    expect(emergency).toBeNull();
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
    expect(history.previousStatus).toBe('PENDING');
    expect(history.newStatus).toBe('VALIDATED');
    expect(history.actor).toBe('operador-1');
    expect(history.reason).toBe('Confirmado por operador');

    const historyList = await repository.findHistoryByEmergencyId(input.id);
    expect(historyList).toHaveLength(1);
  });

  it('persiste closed_at y lo propaga al outbox al cerrar una emergencia resuelta', async () => {
    const officerId = 'of-001';
    await getPool().query(
      `UPDATE officers SET status = 'disponible', updated_at = now() WHERE id = $1`,
      [officerId]
    );

    const input = buildEmergency();
    await repository.create(input);
    await repository.updateStatus(input.id, { newStatus: 'VALIDATED', actor: 'operador-1' });
    await repository.assignOfficer(input.id, { officerId, actor: 'operador-1' });
    await repository.updateStatus(input.id, { newStatus: 'EN_ROUTE', actor: 'operador-1' });
    await repository.updateStatus(input.id, { newStatus: 'ON_SCENE', actor: 'operador-1' });
    await repository.updateStatus(input.id, { newStatus: 'RESOLVED', actor: 'operador-1' });

    const { emergency, history } = await repository.updateStatus(input.id, {
      newStatus: 'CLOSED',
      actor: 'operador-1',
      outboxEvent: {
        topic: 'emergencias.cerrada',
        payload: ({ emergency: savedEmergency }, eventId) => ({
          type: 'EmergenciaCerrada',
          eventId,
          correlationId: savedEmergency.correlationId,
          data: {
            id: savedEmergency.id,
            closedAt: savedEmergency.closedAt,
          },
        }),
      },
    });

    expect(emergency.status).toBe('CLOSED');
    expect(emergency.closedAt).toBeDefined();
    expect(history.previousStatus).toBe('RESOLVED');
    expect(history.newStatus).toBe('CLOSED');

    const raw = await getPool().query(
      'SELECT closed_at FROM emergencies WHERE id = $1',
      [input.id]
    );
    expect(raw.rows[0].closed_at).toBeDefined();
    expect(raw.rows[0].closed_at.getTime()).toBe(emergency.closedAt.getTime());

    const outbox = await getPool().query(
      `SELECT payload
       FROM outbox_events
       WHERE topic = 'emergencias.cerrada'
         AND payload->'data'->>'id' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.id]
    );
    expect(outbox.rows[0].payload.correlationId).toBe(input.id);
    expect(outbox.rows[0].payload.data.closedAt).toBe(emergency.closedAt.toISOString());
  });

  it('al asignar marca al oficial ocupado y al devolver a VALIDATED lo libera (misma tx)', async () => {
    const officerId = 'of-001';
    await getPool().query(
      `UPDATE officers SET status = 'disponible', updated_at = now() WHERE id = $1`,
      [officerId]
    );

    const input = buildEmergency();
    await repository.create(input);
    await repository.updateStatus(input.id, { newStatus: 'VALIDATED', actor: 'operador-1' });

    const { emergency: dispatched, officer } = await repository.assignOfficer(input.id, {
      officerId,
      actor: 'operador-1',
    });

    expect(dispatched.status).toBe('DISPATCHED');
    expect(dispatched.assignedOfficerId).toBe(officerId);
    expect(officer.status).toBe('ocupado');

    const busy = await getPool().query('SELECT status FROM officers WHERE id = $1', [officerId]);
    expect(busy.rows[0].status).toBe('ocupado');

    const { emergency: returned } = await repository.updateStatus(input.id, {
      newStatus: 'VALIDATED',
      actor: 'operador-1',
      reason: 'Devolución para reasignar',
    });
    expect(returned.status).toBe('VALIDATED');

    const free = await getPool().query('SELECT status FROM officers WHERE id = $1', [officerId]);
    expect(free.rows[0].status).toBe('disponible');

    // El mismo oficial se puede reasignar sin 409.
    await expect(
      repository.assignOfficer(input.id, { officerId, actor: 'operador-1' })
    ).resolves.toMatchObject({
      emergency: expect.objectContaining({ status: 'DISPATCHED', assignedOfficerId: officerId }),
      officer: expect.objectContaining({ status: 'ocupado' }),
    });

    // Dejar el seed usable para otros tests / demos locales.
    await repository.updateStatus(input.id, { newStatus: 'VALIDATED', actor: 'operador-1' });
  });

  it('findDetailById devuelve la emergencia con su historial de estados (tarea #32)', async () => {
    const input = buildEmergency({ emergencyType: 'medical' });
    await repository.create(input);

    await repository.updateStatus(input.id, {
      newStatus: 'VALIDATED',
      actor: 'D000007',
    });

    const detail = await repository.findDetailById(input.id);

    expect(detail).toMatchObject({
      id: input.id,
      correlationId: input.id,
      userId: input.userId,
      emergencyType: 'MEDICA',
      status: 'VALIDATED',
      assignedOfficerId: null,
    });
    expect(Number(detail.latitude)).toBeCloseTo(input.latitude);
    expect(detail.statusHistory).toHaveLength(1);
    expect(detail.statusHistory[0]).toMatchObject({
      emergencyId: input.id,
      previousStatus: 'PENDING',
      newStatus: 'VALIDATED',
      actor: 'D000007',
      reason: null,
    });
    expect(detail.statusHistory[0].createdAt).toBeDefined();
  });

  it('findDetailById devuelve null si la emergencia no existe', async () => {
    expect(await repository.findDetailById(randomUUID())).toBeNull();
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

  it('findPage devuelve latitude/longitude desencriptadas, no null', async () => {
    const input = buildEmergency();
    await repository.create(input);

    const { emergencies, total } = await repository.findPage({
      statuses: [],
      page: 1,
      limit: 50,
      sortBy: 'createdAt',
      order: 'desc',
    });

    expect(total).toBeGreaterThan(0);
    const found = emergencies.find((emergency) => emergency.id === input.id);
    expect(found).toBeDefined();
    expect(found.latitude).not.toBeNull();
    expect(found.longitude).not.toBeNull();
    expect(Number(found.latitude)).toBeCloseTo(input.latitude);
    expect(Number(found.longitude)).toBeCloseTo(input.longitude);
  });

  it('una fila con ciphertext indescifrable no tumba el listado y se puede sanear', async () => {
    const good = buildEmergency();
    await repository.create(good);
    const badId = randomUUID();
    await getPool().query(
      `INSERT INTO emergencies (id, user_id, latitude, longitude, location_encrypted, description, severity, status)
       VALUES ($1, 'user-bad', NULL, NULL, $2, 'cifrada con otra clave', 'high', 'PENDING')`,
      [badId, Buffer.from('not-a-valid-ciphertext-at-all-0123456789').toString('base64')]
    );

    const { emergencies } = await repository.findPage({
      statuses: [],
      page: 1,
      limit: 100,
      sortBy: 'createdAt',
      order: 'desc',
    });
    const bad = emergencies.find((emergency) => emergency.id === badId);
    const ok = emergencies.find((emergency) => emergency.id === good.id);
    expect(bad).toBeDefined();
    expect(bad.latitude).toBeNull();
    expect(bad.longitude).toBeNull();
    expect(bad.locationUnavailable).toBe(true);
    expect(ok.locationUnavailable).toBe(false);
    expect(Number(ok.latitude)).toBeCloseTo(good.latitude);

    const result = await repository.anonymizeUndecryptableLocations();
    expect(result.ids).toContain(badId);
    expect(result.ids).not.toContain(good.id);

    const after = await repository.findById(badId);
    expect(after.locationAnonymized).toBe(true);
    expect(after.locationUnavailable).toBe(false);
  });

  it('rechaza con ConflictError una transición inválida y no deja rastros (defensa en profundidad)', async () => {
    const input = buildEmergency();
    await repository.create(input);

    // PENDING → RESOLVED se salta el flujo: el repository lo frena aunque
    // ningún controller lo haya validado antes.
    await expect(repository.updateStatus(input.id, { newStatus: 'RESOLVED', actor: 'operador-1' }))
      .rejects.toMatchObject({ name: 'ConflictError', statusCode: 409 });

    const found = await repository.findById(input.id);
    expect(found.status).toBe('PENDING');

    const historyList = await repository.findHistoryByEmergencyId(input.id);
    expect(historyList).toHaveLength(0);
  });

  it('rechaza una transición desde un estado terminal', async () => {
    const input = buildEmergency();
    await repository.create(input);
    await repository.updateStatus(input.id, { newStatus: 'CANCELLED', actor: 'user-123' });

    await expect(repository.updateStatus(input.id, { newStatus: 'VALIDATED', actor: 'operador-1' }))
      .rejects.toMatchObject({ name: 'ConflictError' });

    const found = await repository.findById(input.id);
    expect(found.status).toBe('CANCELLED');

    const historyList = await repository.findHistoryByEmergencyId(input.id);
    expect(historyList).toHaveLength(1);
  });

  it('hace ROLLBACK y no toca la fila si el estado destino no existe', async () => {
    const input = buildEmergency();
    await repository.create(input);

    await expect(repository.updateStatus(input.id, { newStatus: null })).rejects.toThrow();

    const found = await repository.findById(input.id);
    expect(found.status).toBe('PENDING');

    const historyList = await repository.findHistoryByEmergencyId(input.id);
    expect(historyList).toHaveLength(0);
  });
});
