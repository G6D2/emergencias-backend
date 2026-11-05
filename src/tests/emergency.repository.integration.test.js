const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { IncidentRepository } = require('../repositories/incident.repository');
const { buildEmergencyCreatedEvent } = require('../services/emergency-events');

// Mismo outboxEvent que arma PanicButtonController: el builder real del
// contrato del #48, no un payload inventado.
const panicOutboxEvent = () => ({
  topic: 'emergencias.boton-panico',
  payload: (emergency, eventId) => buildEmergencyCreatedEvent(emergency, eventId),
});

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

    const created = await repository.create({ ...input, outboxEvent: panicOutboxEvent() });

    expect(created.emergencyType).toBe('MEDICA');
    expect(created.correlationId).toBe(input.id);

    const outbox = await getPool().query(
      `SELECT payload FROM outbox_events WHERE payload->'data'->>'emergenciaId' = $1`,
      [input.id]
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload.correlationId).toBe(input.id);
    expect(outbox.rows[0].payload.data).toMatchObject({
      emergenciaId: input.id,
      categoria: 'MEDICA',
      correlationId: input.id,
    });
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

  describe('incident embebido y effectivePriority (visibilidad del motor de incidentes, apilado sobre #36)', () => {
    let incidentRepository;

    beforeAll(() => {
      incidentRepository = new IncidentRepository(getPool(), repository);
    });

    it('findPage: una emergencia sin incidente tiene incident null y effectivePriority = su propia severity', async () => {
      const input = buildEmergency({ severity: 'medium' });
      await repository.create(input);

      const { emergencies } = await repository.findPage({
        statuses: [], page: 1, limit: 200, sortBy: 'createdAt', order: 'desc',
      });

      const found = emergencies.find((e) => e.id === input.id);
      expect(found.incident).toBeNull();
      expect(found.effectivePriority).toBe('medium');
    });

    it('findPage y findDetailById: con incidente vinculado, incident trae reportCount/uniqueCitizens y effectivePriority nunca baja de la severity individual', async () => {
      const incident = await incidentRepository.create({ emergencyType: 'INCENDIO' });
      const memberA = buildEmergency({ severity: 'low', userId: 'user-A', emergencyType: 'INCENDIO' });
      const memberB = buildEmergency({ severity: 'low', userId: 'user-B', emergencyType: 'INCENDIO' });
      await repository.create(memberA);
      await repository.create(memberB);
      await repository.setIncidentId(memberA.id, incident.id);
      await repository.setIncidentId(memberB.id, incident.id);

      await incidentRepository.applyScoringDecision(incident.id, {
        priority: 'critical',
        score: 91,
        reasonCodes: ['MULTI_REPORT_THRESHOLD', 'UNIQUE_CITIZENS_THRESHOLD'],
        factors: { reportCount: 2 },
        algorithmVersion: 'rule-based-v1',
        members: [
          { emergencyId: memberA.id, correlationId: memberA.id, priorityIndividual: 'low', finalPriority: 'critical' },
          { emergencyId: memberB.id, correlationId: memberB.id, priorityIndividual: 'low', finalPriority: 'critical' },
        ],
      });

      const { emergencies } = await repository.findPage({
        statuses: [], page: 1, limit: 200, sortBy: 'createdAt', order: 'desc',
      });
      const foundA = emergencies.find((e) => e.id === memberA.id);

      expect(foundA.incident).toMatchObject({
        id: incident.id,
        priority: 'critical',
        score: 91,
        reportCount: 2,
        uniqueCitizens: 2,
        reasonCodes: ['MULTI_REPORT_THRESHOLD', 'UNIQUE_CITIZENS_THRESHOLD'],
      });
      // severity individual 'low' + incident 'critical' -> la efectiva es 'critical' (nunca baja)
      expect(foundA.effectivePriority).toBe('critical');

      const detail = await repository.findDetailById(memberA.id);
      expect(detail.incident.id).toBe(incident.id);
      expect(detail.effectivePriority).toBe('critical');
    });

    it('sortBy=priority ordena por la prioridad EFECTIVA: una emergencia low agrupada en un incidente critical queda antes que una high sin incidente', async () => {
      const incident = await incidentRepository.create({ emergencyType: 'DISTURBIO_EVENTO_MASIVO' });
      const grouped = buildEmergency({ severity: 'low', emergencyType: 'DISTURBIO_EVENTO_MASIVO' });
      const lonelyHigh = buildEmergency({ severity: 'high', emergencyType: 'DISTURBIO_EVENTO_MASIVO' });
      await repository.create(grouped);
      await repository.create(lonelyHigh);
      await repository.setIncidentId(grouped.id, incident.id);
      await incidentRepository.applyScoringDecision(incident.id, {
        priority: 'critical',
        score: 95,
        reasonCodes: [],
        factors: {},
        algorithmVersion: 'rule-based-v1',
        members: [{ emergencyId: grouped.id, correlationId: grouped.id, priorityIndividual: 'low', finalPriority: 'critical' }],
      });

      const { emergencies } = await repository.findPage({
        statuses: [], emergencyType: 'DISTURBIO_EVENTO_MASIVO', page: 1, limit: 200, sortBy: 'priority', order: 'desc',
      });

      const groupedIndex = emergencies.findIndex((e) => e.id === grouped.id);
      const lonelyIndex = emergencies.findIndex((e) => e.id === lonelyHigh.id);
      expect(groupedIndex).toBeGreaterThanOrEqual(0);
      expect(lonelyIndex).toBeGreaterThanOrEqual(0);
      expect(groupedIndex).toBeLessThan(lonelyIndex);
    });
  });

  it('crea la emergencia y su evento outbox en la misma transacción', async () => {
    const input = buildEmergency();
    const created = await repository.create({ ...input, outboxEvent: panicOutboxEvent() });

    const outbox = await getPool().query(
      `SELECT id, topic, status, payload
       FROM outbox_events
       WHERE payload->'data'->>'emergenciaId' = $1`,
      [input.id]
    );

    expect(created.id).toBe(input.id);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({ topic: 'emergencias.boton-panico', status: 'PENDING' });
    // El eventId que recibe el builder es la PK de la fila.
    expect(outbox.rows[0].payload.eventId).toBe(outbox.rows[0].id);
    expect(outbox.rows[0].payload).toMatchObject({
      type: 'EmergenciaCreada',
      correlationId: input.id,
      data: {
        emergenciaId: input.id,
        prioridad: 'CRITICA',
        estado: 'PENDIENTE',
        ciudadanoId: input.userId,
      },
    });
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
      `UPDATE emergencies SET closed_at = now() - interval '100 hours' WHERE id = $1`,
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

  describe('findRecentByType (candidatos para el job de deteccion de incidentes, #60)', () => {
    it('devuelve solo emergencias del emergencyType pedido, dentro de la ventana, con lat/lng descifrados como numeros', async () => {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const input = buildEmergency({ emergencyType: 'INCENDIO' });
      await repository.create(input);

      const candidates = await repository.findRecentByType({
        emergencyType: 'INCENDIO',
        since,
      });

      const found = candidates.find((candidate) => candidate.id === input.id);
      expect(found).toBeDefined();
      expect(typeof found.latitude).toBe('number');
      expect(typeof found.longitude).toBe('number');
      expect(found.latitude).toBeCloseTo(input.latitude);
      expect(found.longitude).toBeCloseTo(input.longitude);
    });

    it('no devuelve emergencias de otro emergencyType aunque esten en la ventana', async () => {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const other = buildEmergency({ emergencyType: 'MEDICA' });
      await repository.create(other);

      const candidates = await repository.findRecentByType({
        emergencyType: 'INCENDIO',
        since,
      });

      expect(candidates.some((candidate) => candidate.id === other.id)).toBe(false);
    });

    it('no devuelve emergencias fuera de la ventana temporal aunque sean del tipo correcto', async () => {
      const input = buildEmergency({ emergencyType: 'INCENDIO' });
      await repository.create(input);
      await getPool().query(
        `UPDATE emergencies SET created_at = now() - interval '10 hours' WHERE id = $1`,
        [input.id]
      );

      const since = new Date(Date.now() - 60 * 60 * 1000);
      const candidates = await repository.findRecentByType({
        emergencyType: 'INCENDIO',
        since,
      });

      expect(candidates.some((candidate) => candidate.id === input.id)).toBe(false);
    });
  });
});
