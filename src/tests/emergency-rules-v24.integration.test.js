const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../app');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

const DISPATCHER = { sub: 'D-lifecycle', groups: ['dispatcher'] };
const CITIZEN = { sub: 'user-lifecycle', groups: ['citizen'] };
// of-001/of-002 los usan otras suites; esta trabaja con su propio oficial.
const OFFICER_ID = 'of-003';
const V24_PATH = path.resolve(__dirname, '..', '..', 'db', 'migrations', 'V24__closed_at_terminales_e_indices.sql');

describe('Ciclo de vida de una emergencia: validar/devolver, closed_at y V24 (integración contra Postgres real)', () => {
  let pool;
  let repository;
  const createdIds = [];

  function appAs(user) {
    return createApp(mockKafkaService, repository, {
      authenticate: (req, res, next) => { req.user = user; next(); },
    });
  }

  async function createPending() {
    const id = randomUUID();
    createdIds.push(id);
    await repository.create({
      id, userId: CITIZEN.sub, latitude: -34.6037, longitude: -58.3816, description: 'lifecycle', severity: 'high',
    });
    return id;
  }

  // Deja una emergencia DISPATCHED por los mismos caminos que usa la API.
  async function createDispatched() {
    const id = await createPending();
    const dispatcher = appAs(DISPATCHER);
    await request(dispatcher).patch(`/api/emergencies/${id}/validate`).expect(200);
    await request(dispatcher).patch(`/api/emergencies/${id}/assign`).send({ officerId: OFFICER_ID }).expect(200);
    return id;
  }

  const rowOf = async (id) => (await pool.query(
    `SELECT status, assigned_officer_id, closed_at, updated_at, location_encrypted, location_anonymized_at
     FROM emergencies WHERE id = $1`,
    [id]
  )).rows[0];
  const officerStatus = async () => (await pool.query('SELECT status FROM officers WHERE id = $1', [OFFICER_ID])).rows[0].status;
  const historyOf = async (id) => (await pool.query(
    'SELECT previous_status, new_status, reason FROM emergency_status_history WHERE emergency_id = $1 ORDER BY id',
    [id]
  )).rows;

  beforeAll(() => {
    process.env.LOCATION_ENCRYPTION_KEY = process.env.LOCATION_ENCRYPTION_KEY
      || 'flxqyJtbe6+mibyHqK76N6LSnFe0w22hnyDZg9KWIcs=';
    pool = getPool();
    repository = new EmergencyRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("UPDATE officers SET status = 'disponible' WHERE id = $1", [OFFICER_ID]);
  });

  afterAll(async () => {
    // Las suites de integración comparten base: lo que crea esta suite no debe
    // alterar el agrupamiento de incidentes ni los oficiales de las otras.
    await pool.query('DELETE FROM emergency_status_history WHERE emergency_id = ANY($1::uuid[])', [createdIds]);
    await pool.query("DELETE FROM outbox_events WHERE payload->'data'->>'emergenciaId' = ANY($1::text[])", [createdIds]);
    await pool.query('DELETE FROM emergencies WHERE id = ANY($1::uuid[])', [createdIds]);
    await pool.query("UPDATE officers SET status = 'disponible' WHERE id = $1", [OFFICER_ID]);
    await closePool();
  });

  describe('/validate y /return', () => {
    it('validate sobre una DISPATCHED responde 409 y no libera al oficial ni toca la fila', async () => {
      const id = await createDispatched();
      const before = await rowOf(id);

      const res = await request(appAs(DISPATCHER)).patch(`/api/emergencies/${id}/validate`).expect(409);

      expect(res.body.message).toBe(`Emergency ${id} is DISPATCHED, expected PENDING`);
      const after = await rowOf(id);
      expect(after.status).toBe('DISPATCHED');
      expect(after.assigned_officer_id).toBe(OFFICER_ID);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(await officerStatus()).toBe('ocupado');
      expect((await historyOf(id)).map((h) => h.new_status)).toEqual(['VALIDATED', 'DISPATCHED']);
    });

    it('el repository revalida el estado de origen con la fila bloqueada aunque el controller no lo haga', async () => {
      const id = await createDispatched();

      await expect(repository.updateStatus(id, {
        newStatus: 'VALIDATED', actor: DISPATCHER.sub, requireStatus: 'PENDING',
      })).rejects.toMatchObject({ name: 'ConflictError', statusCode: 409 });

      expect((await rowOf(id)).assigned_officer_id).toBe(OFFICER_ID);
      expect(await officerStatus()).toBe('ocupado');
    });

    it('return libera al oficial y deja assigned_officer_id en NULL', async () => {
      const id = await createDispatched();
      expect(await officerStatus()).toBe('ocupado');

      const res = await request(appAs(DISPATCHER))
        .patch(`/api/emergencies/${id}/return`)
        .send({ reason: 'Despacho equivocado' })
        .expect(200);

      expect(res.body.data).toMatchObject({ status: 'VALIDATED', assignedOfficerId: null });
      const row = await rowOf(id);
      expect(row.status).toBe('VALIDATED');
      expect(row.assigned_officer_id).toBeNull();
      expect(row.closed_at).toBeNull();
      expect(await officerStatus()).toBe('disponible');
      expect((await historyOf(id)).at(-1)).toEqual({
        previous_status: 'DISPATCHED', new_status: 'VALIDATED', reason: 'Despacho equivocado',
      });

      // Ya no está DISPATCHED: una segunda devolución es 409.
      await request(appAs(DISPATCHER)).patch(`/api/emergencies/${id}/return`).send({}).expect(409);
    });

    it('return sobre una PENDING responde 409', async () => {
      const id = await createPending();

      await request(appAs(DISPATCHER)).patch(`/api/emergencies/${id}/return`).send({}).expect(409);

      expect((await rowOf(id)).status).toBe('PENDING');
    });
  });

  describe('closed_at en estados terminales y retención de 72 h', () => {
    it('cancelar y descartar setean closed_at, y la retención las anonimiza pasadas las 72 h', async () => {
      const cancelled = await createPending();
      const discarded = await createPending();
      const recentlyCancelled = await createPending();
      const oldPending = await createPending();

      await request(appAs(CITIZEN)).patch(`/api/emergencies/${cancelled}/cancel`).send({ reason: 'Ya no hace falta' }).expect(200);
      await request(appAs(CITIZEN)).patch(`/api/emergencies/${recentlyCancelled}/cancel`).send({}).expect(200);
      await request(appAs(DISPATCHER))
        .patch(`/api/emergencies/${discarded}/discard`)
        .send({ reason: 'Falsa alarma, avisó vecino@example.com' })
        .expect(200);

      for (const id of [cancelled, discarded, recentlyCancelled]) {
        const row = await rowOf(id);
        expect(row.closed_at).not.toBeNull();
        expect(row.closed_at).toEqual(row.updated_at);
      }
      expect((await historyOf(discarded)).at(-1).reason).toBe('Falsa alarma, avisó [email]');

      // Se corre el reloj: cerradas hace 73 h. La PENDING es vieja pero sigue abierta.
      await pool.query(
        "UPDATE emergencies SET closed_at = now() - interval '73 hours' WHERE id = ANY($1::uuid[])",
        [[cancelled, discarded]]
      );
      await pool.query("UPDATE emergencies SET created_at = now() - interval '10 days' WHERE id = $1", [oldPending]);

      const { ids } = await repository.anonymizeExpiredLocations(72);

      expect(ids).toEqual(expect.arrayContaining([cancelled, discarded]));
      expect(ids).not.toContain(recentlyCancelled);
      expect(ids).not.toContain(oldPending);
      for (const id of [cancelled, discarded]) {
        const row = await rowOf(id);
        expect(row.location_encrypted).toBeNull();
        expect(row.location_anonymized_at).not.toBeNull();
      }
      expect((await rowOf(recentlyCancelled)).location_encrypted).not.toBeNull();
      expect((await rowOf(oldPending)).location_encrypted).not.toBeNull();
    });
  });

  describe('V24 sobre una base con filas terminales', () => {
    // Flyway ya aplicó V24 sobre la base vacía en el global setup. Para
    // probarla sobre datos se reconstruye el estado previo (terminales sin
    // closed_at, índices de V3 y V8) y se vuelve a correr el archivo, que es
    // idempotente.
    const indexes = async () => (await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE indexname IN (
         'idx_outbox_events_published_created_at', 'idx_outbox_events_published_published_at',
         'idx_emergencies_location_retention', 'idx_emergencies_location_retention_closed_at'
       )`
    )).rows;

    async function legacyRow(status, { closedAt = null } = {}) {
      const id = await createPending();
      await pool.query(
        `UPDATE emergencies
         SET status = $2, closed_at = $3::timestamptz, updated_at = now() - interval '10 days'
         WHERE id = $1`,
        [id, status, closedAt]
      );
      return id;
    }

    it('rellena closed_at = updated_at solo en terminales sin fecha y reemplaza los índices', async () => {
      await pool.query(`
        DROP INDEX IF EXISTS idx_outbox_events_published_published_at;
        DROP INDEX IF EXISTS idx_emergencies_location_retention_closed_at;
        CREATE INDEX idx_outbox_events_published_created_at
            ON outbox_events (created_at) WHERE status = 'PUBLISHED';
        CREATE INDEX idx_emergencies_location_retention
            ON emergencies (created_at)
            WHERE location_encrypted IS NOT NULL AND location_anonymized_at IS NULL;
      `);
      const cancelled = await legacyRow('CANCELLED');
      const discarded = await legacyRow('DISCARDED');
      const closed = await legacyRow('CLOSED');
      const originalClosedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const closedWithDate = await legacyRow('CLOSED', { closedAt: originalClosedAt });
      const pending = await legacyRow('PENDING');
      const validated = await legacyRow('VALIDATED');

      await pool.query(fs.readFileSync(V24_PATH, 'utf8'));

      for (const id of [cancelled, discarded, closed]) {
        const row = await rowOf(id);
        expect(row.closed_at).not.toBeNull();
        expect(row.closed_at).toEqual(row.updated_at);
      }
      expect((await rowOf(closedWithDate)).closed_at).toEqual(originalClosedAt);
      expect((await rowOf(pending)).closed_at).toBeNull();
      expect((await rowOf(validated)).closed_at).toBeNull();

      // Con closed_at relleno, la retención alcanza a las terminales viejas.
      const { ids } = await repository.anonymizeExpiredLocations(72);
      expect(ids).toEqual(expect.arrayContaining([cancelled, discarded, closed, closedWithDate]));
      expect(ids).not.toContain(pending);
      expect(ids).not.toContain(validated);

      const byName = Object.fromEntries((await indexes()).map((row) => [row.indexname, row.indexdef]));
      expect(Object.keys(byName).sort()).toEqual([
        'idx_emergencies_location_retention_closed_at',
        'idx_outbox_events_published_published_at',
      ]);
      expect(byName.idx_outbox_events_published_published_at)
        .toMatch(/\(published_at\) WHERE \(status = 'PUBLISHED'::text\)/);
      expect(byName.idx_emergencies_location_retention_closed_at)
        .toMatch(/\(closed_at\) WHERE \(location_anonymized_at IS NULL\)/);
    });

    it('el planner puede usar los índices nuevos en el purge del outbox y en la retención', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Sin seq scan, si el predicado del índice no está implicado por la
        // query el planner no tiene otra forma de usarlo.
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = async (sql) => (await client.query(`EXPLAIN ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\n');

        expect(await plan(`
          DELETE FROM outbox_events
          WHERE status = 'PUBLISHED'
            AND published_at < now() - (86400000::double precision * interval '1 millisecond')
        `)).toContain('idx_outbox_events_published_published_at');

        expect(await plan(`
          UPDATE emergencies
          SET location_encrypted = NULL, latitude = NULL, longitude = NULL,
              location_anonymized_at = now(), updated_at = now()
          WHERE location_anonymized_at IS NULL
            AND closed_at IS NOT NULL
            AND (location_encrypted IS NOT NULL OR latitude IS NOT NULL OR longitude IS NOT NULL)
            AND closed_at < now() - (72::double precision * interval '1 hour')
        `)).toContain('idx_emergencies_location_retention_closed_at');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
