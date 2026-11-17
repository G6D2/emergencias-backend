// Idempotency-Key en POST /api/panic-button contra Postgres real (V34): app
// armada como en producción (authenticate real con JWT RS256 local,
// EmergencyRepository real). Verifica que un reintento no duplique la
// emergencia ni su EmergenciaCreada del outbox, también con pedidos
// simultáneos, y que la clave sea por usuario y venza a las 24 h.

const { randomUUID } = require('crypto');
const request = require('supertest');
const { getPool, closePool } = require('../db/pool');
const { createApp } = require('../app');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { PANIC_BUTTON_IDEMPOTENCY_SCOPE } = require('../controllers/panic-button.controller');
const { createLocalJwtAuth } = require('./helpers/local-jwt');

const LOCATION = Object.freeze({ latitude: -34.6037, longitude: -58.3816 });
const kafkaApagado = { isEnabled: () => false, publishEvent: async () => false, checkHealth: async () => false };

let pool;
let repository;
let app;
let auth;
const tag = randomUUID().slice(0, 8);
const citizen = { sub: `cit-idem-${tag}`, groups: ['citizen'] };
const otherCitizen = { sub: `cit-idem-otro-${tag}`, groups: ['citizen'] };
const bearers = {};

function panic(as, key, body = {}) {
  const req = request(app).post('/api/panic-button').set('Authorization', bearers[as.sub]);
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send({ location: LOCATION, ...body });
}

async function emergenciesOf(sub) {
  const { rows } = await pool.query('SELECT id FROM emergencies WHERE user_id = $1 ORDER BY created_at', [sub]);
  return rows.map((row) => row.id);
}

async function createdEventsOf(emergencyIds) {
  const { rows } = await pool.query(
    `SELECT id FROM outbox_events
     WHERE payload->>'type' = 'EmergenciaCreada' AND payload->'data'->>'emergenciaId' = ANY($1::text[])`,
    [emergencyIds]
  );
  return rows;
}

async function keyRow(sub, key) {
  const { rows } = await pool.query(
    'SELECT emergency_id, status_code FROM idempotency_keys WHERE scope = $1 AND user_sub = $2 AND idempotency_key = $3',
    [PANIC_BUTTON_IDEMPOTENCY_SCOPE, sub, key]
  );
  return rows[0];
}

beforeAll(async () => {
  // La suite manda varios POST seguidos desde la misma IP (el límite real es 5/min).
  process.env.RATE_LIMIT_ENABLED = 'false';
  pool = getPool();
  auth = await createLocalJwtAuth();
  repository = new EmergencyRepository(pool);
  app = createApp(kafkaApagado, repository, { authenticate: auth.authenticate });
  for (const identity of [citizen, otherCitizen]) {
    bearers[identity.sub] = await auth.bearerFor(identity);
  }
});

afterEach(async () => {
  const ids = [...await emergenciesOf(citizen.sub), ...await emergenciesOf(otherCitizen.sub)];
  if (ids.length > 0) {
    await pool.query("DELETE FROM outbox_events WHERE payload->'data'->>'emergenciaId' = ANY($1::text[])", [ids]);
    await pool.query('DELETE FROM emergencies WHERE id = ANY($1::uuid[])', [ids]);
  }
});

afterAll(async () => {
  await closePool();
});

describe('reintento secuencial', () => {
  it('la misma clave devuelve el mismo status y cuerpo, sin otra emergencia ni otro evento', async () => {
    const key = randomUUID();

    const first = await panic(citizen, key, { emergencyType: 'MEDICA', address: 'Av. Corrientes 1234' });
    const retry = await panic(citizen, key, { emergencyType: 'MEDICA', address: 'Av. Corrientes 1234' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(retry.headers['idempotent-replayed']).toBe('true');

    const ids = await emergenciesOf(citizen.sub);
    expect(ids).toEqual([first.body.emergencyId]);
    expect(await createdEventsOf(ids)).toHaveLength(1);
    expect(await keyRow(citizen.sub, key)).toEqual({ emergency_id: first.body.emergencyId, status_code: 201 });
  });

  it('sin clave cada pedido crea su emergencia, como antes', async () => {
    await panic(citizen).expect(201);
    await panic(citizen).expect(201);

    const ids = await emergenciesOf(citizen.sub);
    expect(ids).toHaveLength(2);
    expect(await createdEventsOf(ids)).toHaveLength(2);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE user_sub = $1', [citizen.sub]);
    expect(rows[0].n).toBe(0);
  });

  it('la misma clave de otro usuario es otra alta', async () => {
    const key = randomUUID();

    const mine = await panic(citizen, key).expect(201);
    const theirs = await panic(otherCitizen, key).expect(201);

    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect(theirs.body.emergencyId).not.toBe(mine.body.emergencyId);
    expect(await emergenciesOf(otherCitizen.sub)).toEqual([theirs.body.emergencyId]);
  });

  it('una clave mal formada da 400 y no crea nada', async () => {
    const response = await panic(citizen, 'clave con espacios').expect(400);

    expect(response.body.message).toMatch(/Idempotency-Key inválida/);
    expect(await emergenciesOf(citizen.sub)).toEqual([]);
  });

  it('pasadas las 24 h la clave vence y el mismo valor crea otra emergencia', async () => {
    const key = randomUUID();
    const first = await panic(citizen, key).expect(201);
    await pool.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '25 hours'
       WHERE user_sub = $1 AND idempotency_key = $2`,
      [citizen.sub, key]
    );

    const later = await panic(citizen, key).expect(201);

    expect(later.headers['idempotent-replayed']).toBeUndefined();
    expect(later.body.emergencyId).not.toBe(first.body.emergencyId);
    expect(await emergenciesOf(citizen.sub)).toHaveLength(2);
    expect((await keyRow(citizen.sub, key)).emergency_id).toBe(later.body.emergencyId);
  });
});

describe('pedidos simultáneos con la misma clave', () => {
  it('ocho pedidos a la vez crean una sola emergencia y un solo evento; todos reciben la misma', async () => {
    const key = randomUUID();

    const responses = await Promise.all(Array.from({ length: 8 }, () => panic(citizen, key)));

    expect(responses.map((res) => res.status)).toEqual(Array(8).fill(201));
    const emergencyIds = new Set(responses.map((res) => res.body.emergencyId));
    expect(emergencyIds.size).toBe(1);
    expect(responses.filter((res) => res.headers['idempotent-replayed'] === undefined)).toHaveLength(1);
    const ids = await emergenciesOf(citizen.sub);
    expect(ids).toEqual([...emergencyIds]);
    expect(await createdEventsOf(ids)).toHaveLength(1);
  });

  // Carrera determinística: el primer pedido tiene la clave reservada en una
  // transacción abierta; el segundo queda esperando en el índice único.
  async function holdKeyInOpenTransaction(key) {
    const client = await pool.connect();
    const emergencyId = randomUUID();
    await client.query('BEGIN');
    await repository.create({
      id: emergencyId, userId: citizen.sub, latitude: LOCATION.latitude, longitude: LOCATION.longitude,
      severity: 'critical', emergencyType: 'PANICO', status: 'PENDING', client,
    });
    await client.query(
      `INSERT INTO idempotency_keys (scope, user_sub, idempotency_key, emergency_id, status_code)
       VALUES ($1, $2, $3, $4, 201)`,
      [PANIC_BUTTON_IDEMPOTENCY_SCOPE, citizen.sub, key, emergencyId]
    );
    return { client, emergencyId };
  }

  async function isStillWaiting(promise, ms = 300) {
    const timeout = new Promise((resolve) => { setTimeout(() => resolve('esperando'), ms); });
    return (await Promise.race([promise.then(() => 'terminó'), timeout])) === 'esperando';
  }

  it('el segundo espera a que el primero confirme y devuelve la emergencia del primero', async () => {
    const key = randomUUID();
    const first = await holdKeyInOpenTransaction(key);
    try {
      const second = panic(citizen, key).then((res) => res);

      expect(await isStillWaiting(second)).toBe(true);
      await first.client.query('COMMIT');

      const response = await second;
      expect(response.status).toBe(201);
      expect(response.headers['idempotent-replayed']).toBe('true');
      expect(response.body.emergencyId).toBe(first.emergencyId);
      expect(await emergenciesOf(citizen.sub)).toEqual([first.emergencyId]);
    } finally {
      first.client.release();
    }
  });

  it('si el primero falla y se deshace, el segundo toma la clave y crea la emergencia', async () => {
    const key = randomUUID();
    const first = await holdKeyInOpenTransaction(key);
    try {
      const second = panic(citizen, key).then((res) => res);

      expect(await isStillWaiting(second)).toBe(true);
      await first.client.query('ROLLBACK');

      const response = await second;
      expect(response.status).toBe(201);
      expect(response.headers['idempotent-replayed']).toBeUndefined();
      expect(response.body.emergencyId).not.toBe(first.emergencyId);
      const ids = await emergenciesOf(citizen.sub);
      expect(ids).toEqual([response.body.emergencyId]);
      expect(await createdEventsOf(ids)).toHaveLength(1);
    } finally {
      first.client.release();
    }
  });
});

describe('limpieza', () => {
  it('la purga borra solo las claves vencidas', async () => {
    const vieja = randomUUID();
    const nueva = randomUUID();
    await panic(citizen, vieja).expect(201);
    await panic(citizen, nueva).expect(201);
    await pool.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '25 hours'
       WHERE user_sub = $1 AND idempotency_key = $2`,
      [citizen.sub, vieja]
    );

    const purger = new EmergencyRepository(pool);
    await expect(purger.purgeExpiredIdempotencyKeysIfDue()).resolves.toBeGreaterThanOrEqual(1);

    expect(await keyRow(citizen.sub, vieja)).toBeUndefined();
    expect(await keyRow(citizen.sub, nueva)).toBeDefined();
  });

  it('borrar la emergencia borra su clave (ON DELETE CASCADE)', async () => {
    const key = randomUUID();
    const res = await panic(citizen, key).expect(201);

    await pool.query("DELETE FROM outbox_events WHERE payload->'data'->>'emergenciaId' = $1", [res.body.emergencyId]);
    await pool.query('DELETE FROM emergencies WHERE id = $1', [res.body.emergencyId]);

    expect(await keyRow(citizen.sub, key)).toBeUndefined();
  });
});
