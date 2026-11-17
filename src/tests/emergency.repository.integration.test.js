const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { IncidentRepository } = require('../repositories/incident.repository');
const {
  buildEmergencyCreatedEvent,
  buildEmergencyUpdatedEvent,
  buildEmergencyPrioritizedEvent,
} = require('../services/emergency-events');
const { createBusLocationCrypto } = require('../security/bus-location-crypto');

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

  describe('findPage con officerScope (vista del oficial, issue #17)', () => {
    // Oficiales propios: los del seed los usan otros tests y pueden quedar
    // con emergencias asignadas.
    const officerA = `of-it17-a-${randomUUID().slice(0, 8)}`;
    const officerB = `of-it17-b-${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      await getPool().query(
        `INSERT INTO officers (id, name, badge_number) VALUES ($1, 'Oficial A', 'IT-A'), ($2, 'Oficial B', 'IT-B')`,
        [officerA, officerB]
      );
    });

    afterAll(async () => {
      await getPool().query('DELETE FROM officers WHERE id = ANY($1)', [[officerA, officerB]]);
    });

    // Un oficial con una RESOLVED sigue ocupado hasta el cierre: se libera a
    // mano para poder darle otra.
    async function dispatchedTo(officerId) {
      await getPool().query(`UPDATE officers SET status = 'disponible' WHERE id = $1`, [officerId]);
      const input = buildEmergency();
      await repository.create(input);
      await repository.updateStatus(input.id, { newStatus: 'VALIDATED', actor: 'operador-1' });
      await repository.assignOfficer(input.id, { officerId, actor: 'operador-1' });
      return input.id;
    }

    async function advance(id, statuses) {
      for (const newStatus of statuses) {
        await repository.updateStatus(id, { newStatus, actor: 'oficial' });
      }
    }

    async function idsFor(officerId, officerScope) {
      const { emergencies, total } = await repository.findPage({
        statuses: [], assignedOfficerId: officerId, officerScope, page: 1, limit: 100, sortBy: 'createdAt', order: 'desc',
      });
      expect(total).toBe(emergencies.length);
      return emergencies.map((emergency) => emergency.id).sort();
    }

    it('active trae lo que tiene en curso; history, lo terminado y lo que le devolvieron', async () => {
      // Resuelta por A y cerrada después: en el historial de A.
      const closed = await dispatchedTo(officerA);
      await advance(closed, ['EN_ROUTE', 'ON_SCENE', 'RESOLVED', 'CLOSED']);
      // Devuelta a A y reasignada a B: historial de A, en curso para B.
      const returned = await dispatchedTo(officerA);
      await repository.updateStatus(returned, { newStatus: 'VALIDATED', actor: 'operador-1', reason: 'Reasignar' });
      await repository.assignOfficer(returned, { officerId: officerB, actor: 'operador-1' });
      // Resuelta por A (el dispatcher todavía no la cerró): historial de A.
      const resolved = await dispatchedTo(officerA);
      await advance(resolved, ['EN_ROUTE', 'ON_SCENE', 'RESOLVED']);
      // Devuelta a A y reasignada a A otra vez: en curso, no en el historial.
      const reassigned = await dispatchedTo(officerA);
      await repository.updateStatus(reassigned, { newStatus: 'VALIDATED', actor: 'operador-1' });
      await repository.assignOfficer(reassigned, { officerId: officerA, actor: 'operador-1' });

      expect(await idsFor(officerA, 'active')).toEqual([reassigned]);
      expect(await idsFor(officerA, 'history')).toEqual([closed, returned, resolved].sort());
      expect(await idsFor(officerB, 'active')).toEqual([returned]);
      expect(await idsFor(officerB, 'history')).toEqual([]);
    });

    it('V35 guarda el oficial en cada fila de asignación del historial', async () => {
      const id = await dispatchedTo(officerB);

      const { rows } = await getPool().query(
        'SELECT new_status, officer_id FROM emergency_status_history WHERE emergency_id = $1 ORDER BY id',
        [id]
      );

      expect(rows).toEqual([
        { new_status: 'VALIDATED', officer_id: null },
        { new_status: 'DISPATCHED', officer_id: officerB },
      ]);
    });
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

    const audit = await getPool().query(
      'SELECT actor_sub, action FROM emergency_access_audit WHERE emergency_id = $1',
      [input.id]
    );
    expect(audit.rows).toEqual([{ actor_sub: 'U000999', action: 'emergency:read' }]);

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

  // El outbox guarda el payload de cada evento más allá de las 72 h (los
  // PUBLISHED hasta su purga; SKIPPED, FAILED y PENDING sin plazo). Al
  // anonimizar una emergencia no puede quedar ahí ninguna coordenada suya: ni
  // la exacta cifrada (data.ubicacion) ni la aproximada en claro de la raíz
  // (data.latitud / data.longitud, desde el #92).
  describe('retención: coordenadas en los payloads del outbox', () => {
    const TOPIC = `test.retencion.outbox.${randomUUID().slice(0, 8)}`;
    // Clave solo de este test: hace falta una para que el builder real cifre.
    const busCrypto = createBusLocationCrypto({
      keys: { bus1: Buffer.alloc(32, 9).toString('base64') },
      activeKeyId: 'bus1',
    });

    afterEach(async () => {
      await getPool().query('DELETE FROM outbox_events WHERE topic = $1', [TOPIC]);
    });

    // build recibe el id de la fila, que es el eventId del payload.
    async function insertOutboxRow(build, status) {
      const id = randomUUID();
      const payload = build(id);
      await getPool().query(
        `INSERT INTO outbox_events (id, topic, payload, status) VALUES ($1, $2, $3::jsonb, $4)`,
        [id, TOPIC, JSON.stringify(payload), status]
      );
      // Ida y vuelta por JSON: así se compara contra lo que devuelve Postgres.
      return { id, payload: JSON.parse(JSON.stringify(payload)) };
    }

    async function payloadOf(id) {
      const { rows } = await getPool().query('SELECT payload FROM outbox_events WHERE id = $1', [id]);
      return rows[0].payload;
    }

    async function closeHoursAgo(emergencyId, hours) {
      await getPool().query(
        `UPDATE emergencies SET closed_at = now() - ($2::double precision * interval '1 hour') WHERE id = $1`,
        [emergencyId, hours]
      );
    }

    function withoutCoordinates(payload) {
      return {
        ...payload,
        data: {
          ...payload.data,
          latitud: null,
          longitud: null,
          ubicacion: { ...payload.data.ubicacion, latitud: null, longitud: null },
        },
      };
    }

    it('pone en null las aproximadas de la raíz y las cifradas de ubicacion, conserva el barrio y no toca otra emergencia', async () => {
      const expired = await repository.create(buildEmergency());
      const recent = await repository.create(buildEmergency());
      const closing = { previousStatus: 'RESOLVED', newStatus: 'CLOSED' };

      const creada = await insertOutboxRow(
        (eventId) => buildEmergencyCreatedEvent(expired, eventId, { busCrypto }),
        'PUBLISHED'
      );
      const actualizada = await insertOutboxRow(
        (eventId) => buildEmergencyUpdatedEvent(
          { emergency: expired, history: closing, actor: 'U000999', reason: null, eventId },
          { busCrypto }
        ),
        'SKIPPED'
      );
      // Sin clave de bus la exacta ya sale en null y solo viaja la aproximada.
      const sinClaveDeBus = await insertOutboxRow(
        (eventId) => buildEmergencyCreatedEvent(expired, eventId, { busCrypto: null }),
        'FAILED'
      );
      const deOtraEmergencia = await insertOutboxRow(
        (eventId) => buildEmergencyCreatedEvent(recent, eventId, { busCrypto }),
        'PENDING'
      );

      // El punto de partida es el del contrato: número en la raíz, ciphertext anidado.
      expect(expired.barrio).toEqual(expect.any(String));
      for (const { payload } of [creada, actualizada, deOtraEmergencia]) {
        expect(payload.data).toMatchObject({
          latitud: -34.604,
          longitud: -58.382,
          ubicacion: { latitud: expect.any(String), longitud: expect.any(String) },
        });
      }
      expect(sinClaveDeBus.payload.data).toMatchObject({
        latitud: -34.604,
        longitud: -58.382,
        ubicacion: { latitud: null, longitud: null },
      });

      await closeHoursAgo(expired.id, 100);
      await closeHoursAgo(recent.id, 1);

      const result = await repository.anonymizeExpiredLocations(72);
      expect(result.ids).toContain(expired.id);
      expect(result.ids).not.toContain(recent.id);

      for (const event of [creada, actualizada, sinClaveDeBus]) {
        const after = await payloadOf(event.id);
        expect(after.data.latitud).toBeNull();
        expect(after.data.longitud).toBeNull();
        expect(after.data.ubicacion.latitud).toBeNull();
        expect(after.data.ubicacion.longitud).toBeNull();
        expect(after.data.barrio).toBe(expired.barrio);
        expect(after.data.ubicacion.barrio).toBe(expired.barrio);
        // Nada más cambia en el payload.
        expect(after).toEqual(withoutCoordinates(event.payload));
      }

      expect(await payloadOf(deOtraEmergencia.id)).toEqual(deOtraEmergencia.payload);
    });

    it('un payload sin data.ubicacion: limpia la raíz y no le crea ubicacion', async () => {
      const expired = await repository.create(buildEmergency());
      const sinUbicacion = await insertOutboxRow((eventId) => {
        const event = buildEmergencyCreatedEvent(expired, eventId, { busCrypto });
        delete event.data.ubicacion;
        return event;
      }, 'PUBLISHED');
      expect(sinUbicacion.payload.data.latitud).toBe(-34.604);

      await closeHoursAgo(expired.id, 100);
      await repository.anonymizeExpiredLocations(72);

      const after = await payloadOf(sinUbicacion.id);
      expect(after).toEqual({
        ...sinUbicacion.payload,
        data: { ...sinUbicacion.payload.data, latitud: null, longitud: null },
      });
      expect(after.data).not.toHaveProperty('ubicacion');
    });

    it('no agrega claves a payloads anteriores al #92 ni toca los que no llevan coordenadas', async () => {
      const expired = await repository.create(buildEmergency());

      // #82 a #92: coordenadas cifradas en ubicacion, sin latitud/longitud en la raíz.
      const sinRaiz = await insertOutboxRow((eventId) => {
        const event = buildEmergencyCreatedEvent(expired, eventId, { busCrypto });
        delete event.data.latitud;
        delete event.data.longitud;
        return event;
      }, 'SKIPPED');
      // Antes del #82: latitud/longitud null en la raíz y ubicacion solo con barrio.
      const soloBarrio = await insertOutboxRow((eventId) => {
        const event = buildEmergencyCreatedEvent(expired, eventId, { busCrypto: null });
        event.data.latitud = null;
        event.data.longitud = null;
        event.data.ubicacion = { barrio: expired.barrio };
        return event;
      }, 'SKIPPED');
      const priorizada = await insertOutboxRow((eventId) => buildEmergencyPrioritizedEvent({
        emergencyId: expired.id,
        correlationId: expired.id,
        incidentId: randomUUID(),
        priorityIndividual: 'critical',
        incidentPriority: 'critical',
        priority: 'critical',
        score: 90,
        reasonCodes: ['TEST'],
        algorithmVersion: 'test',
        eventId,
      }), 'SKIPPED');

      await closeHoursAgo(expired.id, 100);
      await repository.anonymizeExpiredLocations(72);

      const afterSinRaiz = await payloadOf(sinRaiz.id);
      expect(afterSinRaiz.data.ubicacion).toEqual({ barrio: expired.barrio, latitud: null, longitud: null });
      expect(afterSinRaiz.data).not.toHaveProperty('latitud');
      expect(afterSinRaiz.data).not.toHaveProperty('longitud');

      expect(await payloadOf(soloBarrio.id)).toEqual(soloBarrio.payload);
      expect(await payloadOf(priorizada.id)).toEqual(priorizada.payload);
    });
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

  describe('findPage: orden determinístico entre filas empatadas', () => {
    const MISMO_INSTANTE = '2026-11-10T15:00:00.000Z';
    let userId;
    let idsAscendentes;

    // Seis emergencias del mismo usuario, misma severity y mismo created_at:
    // lo único que las distingue es el id. Se insertan de mayor a menor id
    // para que el orden físico de la tabla sea el contrario al esperado.
    beforeEach(async () => {
      userId = `user-empate-${randomUUID()}`;
      idsAscendentes = Array.from({ length: 6 }, () => randomUUID()).sort();
      for (const id of [...idsAscendentes].reverse()) {
        await repository.create(buildEmergency({ id, userId, severity: 'high' }));
      }
      await getPool().query(
        'UPDATE emergencies SET created_at = $1 WHERE user_id = $2',
        [MISMO_INSTANTE, userId]
      );
    });

    async function recorrerPaginas({ sortBy, order }) {
      const ids = [];
      let total;
      for (let page = 1; page <= 3; page += 1) {
        const result = await repository.findPage({ userId, statuses: [], page, limit: 2, sortBy, order });
        ids.push(...result.emergencies.map((emergency) => emergency.id));
        total = result.total;
      }
      return { ids, total };
    }

    it.each([
      ['createdAt', 'desc'],
      ['createdAt', 'asc'],
      ['priority', 'desc'],
      ['priority', 'asc'],
    ])('sortBy=%s order=%s: desempata por id y ninguna fila se repite ni falta al paginar', async (sortBy, order) => {
      const { ids, total } = await recorrerPaginas({ sortBy, order });

      expect(total).toBe(6);
      expect(ids).toEqual(idsAscendentes);
    });

    it('el desempate no pisa el criterio principal: created_at sigue mandando', async () => {
      const [masNueva] = idsAscendentes.slice(-1);
      await getPool().query(
        "UPDATE emergencies SET created_at = $1::timestamptz + interval '1 minute' WHERE id = $2",
        [MISMO_INSTANTE, masNueva]
      );

      const { ids } = await recorrerPaginas({ sortBy: 'createdAt', order: 'desc' });

      expect(ids).toEqual([masNueva, ...idsAscendentes.slice(0, -1)]);
    });
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

    it('con emergencyTypes trae varios tipos en una sola query, cada candidato con su emergencyType', async () => {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const panico = buildEmergency({ emergencyType: 'PANICO' });
      const medica = buildEmergency({ emergencyType: 'MEDICA' });
      const otro = buildEmergency({ emergencyType: 'OTRO' });
      await repository.create(panico);
      await repository.create(medica);
      await repository.create(otro);

      const candidates = await repository.findRecentByType({
        emergencyTypes: ['PANICO', 'MEDICA'],
        since,
      });

      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      expect(byId.get(panico.id).emergencyType).toBe('PANICO');
      expect(byId.get(medica.id).emergencyType).toBe('MEDICA');
      expect(byId.has(otro.id)).toBe(false);
    });

    it.each(['CLOSED', 'CANCELLED', 'DISCARDED'])('no devuelve emergencias en estado terminal (%s)', async (terminalStatus) => {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const terminal = buildEmergency({ emergencyType: 'INCENDIO' });
      const active = buildEmergency({ emergencyType: 'INCENDIO' });
      await repository.create(terminal);
      await repository.create(active);
      await getPool().query('UPDATE emergencies SET status = $1 WHERE id = $2', [terminalStatus, terminal.id]);

      const candidates = await repository.findRecentByType({ emergencyType: 'INCENDIO', since });

      const ids = candidates.map((candidate) => candidate.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(terminal.id);
    });
  });
});
