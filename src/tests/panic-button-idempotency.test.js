// Idempotency-Key en POST /api/panic-button: validación del header, rutas con
// un repository en memoria y el método del repository con pool/client
// simulados. Contra Postgres real (carrera incluida):
// panic-button-idempotency.integration.test.js.

const request = require('supertest');
const { createApp } = require('../app');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { ConflictError } = require('../errors/app-errors');
const {
  parseIdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} = require('../utils/idempotency-key');
const {
  PanicButtonController,
  PANIC_BUTTON_IDEMPOTENCY_SCOPE,
} = require('../controllers/panic-button.controller');

const LOCATION = { latitude: -34.6037, longitude: -58.3816 };
const KEY = '8e03978e-40d5-43e8-bc93-6894a57f9324';

describe('parseIdempotencyKey', () => {
  it.each([
    [undefined],
    [null],
    [''],
    ['   '],
    ['""'],
  ])('sin clave (%p) devuelve null: el alta sigue como siempre', (raw) => {
    expect(parseIdempotencyKey(raw)).toBeNull();
  });

  it.each([
    [KEY, KEY],
    ['client-key-abc', 'client-key-abc'],
    ['01HZX3V4Q5R6S7T8U9V0W1X2Y3', '01HZX3V4Q5R6S7T8U9V0W1X2Y3'],
    ['sos:2026.11.17_a', 'sos:2026.11.17_a'],
    [`  ${KEY}  `, KEY],
    [`"${KEY}"`, KEY],
    ['a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH), 'a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)],
  ])('acepta %p', (raw, expected) => {
    expect(parseIdempotencyKey(raw)).toBe(expected);
  });

  it.each([
    ['a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)],
    ['con espacio'],
    [`${KEY}, ${KEY}`],
    ['ñandú'],
    ['clave/con/barras'],
    ['tab\tadentro'],
    ['<script>'],
  ])('rechaza %p con 400', (raw) => {
    expect(() => parseIdempotencyKey(raw)).toThrow(expect.objectContaining({
      name: 'ValidationError',
      statusCode: 400,
      message: expect.stringContaining('Idempotency-Key inválida'),
    }));
  });
});

describe('POST /api/panic-button con Idempotency-Key (repository en memoria)', () => {
  const citizen = { sub: 'U000042', groups: ['citizen'] };

  // Mismo contrato que EmergencyRepository: una clave por (scope, usuario).
  function createRepository() {
    const emergencies = new Map();
    const keys = new Map();
    const calls = { create: 0, createWithIdempotencyKey: [] };
    return {
      emergencies,
      calls,
      create: async ({ outboxEvent, ...emergency }) => {
        void outboxEvent;
        calls.create += 1;
        const saved = { ...emergency, locationAnonymized: false };
        emergencies.set(saved.id, saved);
        return saved;
      },
      createWithIdempotencyKey: async ({ idempotency, outboxEvent, ...emergency }) => {
        void outboxEvent;
        calls.createWithIdempotencyKey.push(idempotency);
        const id = `${idempotency.scope}|${idempotency.userSub}|${idempotency.key}`;
        if (keys.has(id)) {
          const stored = keys.get(id);
          return { emergency: emergencies.get(stored.emergencyId), statusCode: stored.statusCode, replayed: true };
        }
        const saved = { ...emergency, locationAnonymized: false };
        emergencies.set(saved.id, saved);
        keys.set(id, { emergencyId: saved.id, statusCode: idempotency.statusCode });
        return { emergency: saved, statusCode: idempotency.statusCode, replayed: false };
      },
    };
  }

  function appFor(repository, user = citizen) {
    return createApp({ checkHealth: async () => false }, repository, {
      authenticate: (req, res, next) => {
        req.user = user;
        next();
      },
    });
  }

  it('el reintento con la misma clave devuelve el mismo status y cuerpo, sin crear otra emergencia', async () => {
    const repository = createRepository();
    const app = appFor(repository);

    const first = await request(app).post('/api/panic-button').set('Idempotency-Key', KEY)
      .send({ location: LOCATION }).expect(201);
    const retry = await request(app).post('/api/panic-button').set('Idempotency-Key', KEY)
      .send({ location: LOCATION }).expect(201);

    expect(retry.body).toEqual(first.body);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(repository.emergencies.size).toBe(1);
    expect(repository.calls.create).toBe(0);
    expect(repository.calls.createWithIdempotencyKey[0]).toEqual({
      scope: PANIC_BUTTON_IDEMPOTENCY_SCOPE,
      userSub: 'U000042',
      key: KEY,
      statusCode: 201,
    });
  });

  it('la misma clave de otro usuario es otra alta', async () => {
    const repository = createRepository();

    await request(appFor(repository)).post('/api/panic-button').set('Idempotency-Key', KEY)
      .send({ location: LOCATION }).expect(201);
    const other = await request(appFor(repository, { sub: 'U000099', groups: ['citizen'] }))
      .post('/api/panic-button').set('Idempotency-Key', KEY)
      .send({ location: LOCATION }).expect(201);

    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(repository.emergencies.size).toBe(2);
  });

  it('sin clave (o con el header vacío) cada pedido crea una emergencia, como antes', async () => {
    const repository = createRepository();
    const app = appFor(repository);

    await request(app).post('/api/panic-button').send({ location: LOCATION }).expect(201);
    await request(app).post('/api/panic-button').set('Idempotency-Key', '')
      .send({ location: LOCATION }).expect(201);

    expect(repository.calls.create).toBe(2);
    expect(repository.calls.createWithIdempotencyKey).toHaveLength(0);
    expect(repository.emergencies.size).toBe(2);
  });

  it('una clave mal formada corta con 400 antes de tocar la base', async () => {
    const repository = createRepository();

    const response = await request(appFor(repository)).post('/api/panic-button')
      .set('Idempotency-Key', 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))
      .send({ location: LOCATION }).expect(400);

    expect(response.body).toEqual({
      error: 'ValidationError',
      message: expect.stringContaining('Idempotency-Key inválida'),
    });
    expect(repository.calls.create).toBe(0);
    expect(repository.calls.createWithIdempotencyKey).toHaveLength(0);
  });

  it('un body inválido con clave sigue dando 400 y no reserva la clave', async () => {
    const repository = createRepository();

    await request(appFor(repository)).post('/api/panic-button').set('Idempotency-Key', KEY)
      .send({}).expect(400);

    expect(repository.calls.createWithIdempotencyKey).toHaveLength(0);
  });

  it('el controller llamado sin opciones crea sin clave (mismo contrato que antes)', async () => {
    const repository = createRepository();

    const result = await new PanicButtonController(repository).triggerPanicButton({ location: LOCATION }, citizen);

    expect(result).toMatchObject({ statusCode: 201, replayed: false, body: { success: true } });
    expect(repository.calls.create).toBe(1);
  });

  it('el 409 del repository (clave en uso) llega tal cual al cliente', async () => {
    const repository = {
      ...createRepository(),
      createWithIdempotencyKey: async () => {
        throw new ConflictError('Idempotency-Key en uso por otro pedido: reintentá');
      },
    };

    const response = await request(appFor(repository)).post('/api/panic-button')
      .set('Idempotency-Key', KEY).send({ location: LOCATION }).expect(409);

    expect(response.body.error).toBe('ConflictError');
  });
});

describe('EmergencyRepository.createWithIdempotencyKey (pool simulado)', () => {
  const fakeCrypto = {
    encryptLocation: () => 'encrypted-blob',
    decryptLocation: () => ({ latitude: -34.6, longitude: -58.4 }),
  };
  const idempotency = {
    scope: PANIC_BUTTON_IDEMPOTENCY_SCOPE, userSub: 'U000042', key: KEY, statusCode: 201,
  };
  const data = {
    id: 'e-1', userId: 'U000042', latitude: -34.6, longitude: -58.4, severity: 'critical', emergencyType: 'PANICO',
  };

  function createClient({ reservationRowCount = 1, failOn = null } = {}) {
    const calls = [];
    return {
      calls,
      sqls: () => calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim()),
      query: jest.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (failOn && sql.includes(failOn)) throw new Error(`falló ${failOn}`);
        if (sql.includes('INSERT INTO idempotency_keys')) {
          return { rowCount: reservationRowCount, rows: reservationRowCount ? [{ emergency_id: 'e-1' }] : [] };
        }
        if (sql.includes('INSERT INTO emergencies')) {
          return { rowCount: 1, rows: [{ id: 'e-1', correlation_id: 'e-1', user_id: 'U000042', status: 'PENDING' }] };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: jest.fn(),
    };
  }

  function createPool(client, { query } = {}) {
    return {
      connect: jest.fn(async () => client),
      query: jest.fn(query || (async () => ({ rowCount: 0, rows: [] }))),
    };
  }

  it('reserva la clave y crea la emergencia y su evento en la misma transacción', async () => {
    const client = createClient();
    const pool = createPool(client);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto, idempotencyKeyTtlMs: 1000 });

    const result = await repo.createWithIdempotencyKey({
      idempotency,
      ...data,
      outboxEvent: { topic: 'emergencias.boton-panico', payload: { type: 'EmergenciaCreada' } },
    });

    expect(result).toMatchObject({ statusCode: 201, replayed: false, emergency: { id: 'e-1' } });
    const sqls = client.sqls();
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/^INSERT INTO idempotency_keys/);
    expect(client.calls[1].params).toEqual([PANIC_BUTTON_IDEMPOTENCY_SCOPE, 'U000042', KEY, 'e-1', 201, 1000]);
    expect(sqls.some((sql) => sql.startsWith('INSERT INTO emergencies'))).toBe(true);
    expect(sqls.some((sql) => sql.startsWith('INSERT INTO outbox_events'))).toBe(true);
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('la reserva pisa una clave vencida y espera a un pedido en curso (ON CONFLICT ... WHERE vencida)', async () => {
    const client = createClient();
    const repo = new EmergencyRepository(createPool(client), { locationCrypto: fakeCrypto });

    await repo.createWithIdempotencyKey({ idempotency, ...data });

    const reserve = client.sqls()[1];
    expect(reserve).toMatch(/ON CONFLICT \(scope, user_sub, idempotency_key\) DO UPDATE/);
    expect(reserve).toMatch(/WHERE idempotency_keys\.created_at <= now\(\) - \(\$6::double precision/);
    expect(client.calls[1].params[5]).toBe(24 * 60 * 60 * 1000);
  });

  it('clave ya usada: deshace, no crea nada y devuelve la emergencia guardada con su status', async () => {
    const client = createClient({ reservationRowCount: 0 });
    const pool = createPool(client, {
      query: async (sql) => {
        if (sql.includes('FROM idempotency_keys')) return { rows: [{ emergency_id: 'e-original', status_code: 201 }] };
        if (sql.includes('FROM emergencies')) return { rows: [{ id: 'e-original', correlation_id: 'e-original', status: 'PENDING' }] };
        return { rows: [] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.createWithIdempotencyKey({ idempotency, ...data });

    expect(result).toMatchObject({ statusCode: 201, replayed: true, emergency: { id: 'e-original' } });
    expect(client.sqls()).toEqual([
      'BEGIN',
      expect.stringMatching(/^INSERT INTO idempotency_keys/),
      'ROLLBACK',
    ]);
    const lookup = pool.query.mock.calls.find(([sql]) => sql.includes('FROM idempotency_keys'));
    expect(lookup[1]).toEqual([PANIC_BUTTON_IDEMPOTENCY_SCOPE, 'U000042', KEY]);
  });

  it('si la fila de la clave ya no está al leerla, responde 409 para que el cliente reintente', async () => {
    const client = createClient({ reservationRowCount: 0 });
    const repo = new EmergencyRepository(createPool(client), { locationCrypto: fakeCrypto });

    await expect(repo.createWithIdempotencyKey({ idempotency, ...data })).rejects.toBeInstanceOf(ConflictError);
  });

  it('si falla el alta se deshace también la reserva y el error sube', async () => {
    const client = createClient({ failOn: 'INSERT INTO emergencies' });
    const pool = createPool(client);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await expect(repo.createWithIdempotencyKey({ idempotency, ...data })).rejects.toThrow('falló INSERT INTO emergencies');

    expect(client.sqls().at(-1)).toBe('ROLLBACK');
    expect(client.sqls()).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    // Sin alta no hay purga.
    expect(pool.query).not.toHaveBeenCalled();
  });

  describe('purga de claves vencidas', () => {
    it('después de un alta nueva borra las vencidas, como mucho una vez por hora', async () => {
      const pool = createPool(createClient(), { query: async () => ({ rowCount: 3, rows: [] }) });
      const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto, idempotencyKeyTtlMs: 5000 });

      await expect(repo.purgeExpiredIdempotencyKeysIfDue(10_000_000)).resolves.toBe(3);
      await expect(repo.purgeExpiredIdempotencyKeysIfDue(10_000_000 + 60 * 60 * 1000 - 1)).resolves.toBe(0);
      await expect(repo.purgeExpiredIdempotencyKeysIfDue(10_000_000 + 60 * 60 * 1000)).resolves.toBe(3);

      expect(pool.query).toHaveBeenCalledTimes(2);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toMatch(/DELETE FROM idempotency_keys/);
      expect(params).toEqual([5000]);
    });

    it('el alta nueva dispara la purga', async () => {
      const pool = createPool(createClient(), { query: async () => ({ rowCount: 0, rows: [] }) });
      const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

      await repo.createWithIdempotencyKey({ idempotency, ...data });

      expect(pool.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM idempotency_keys'))).toBe(true);
    });

    it('un error al purgar se loguea y no corta el alta', async () => {
      const pool = createPool(createClient(), {
        query: async () => { throw new Error('db lenta'); },
      });
      const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await repo.createWithIdempotencyKey({ idempotency, ...data });

      expect(result.replayed).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Idempotency-Key vencidas'));
      warnSpy.mockRestore();
    });

    it('un rowCount ausente cuenta como 0', async () => {
      const pool = createPool(createClient(), { query: async () => ({ rows: [] }) });
      const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

      await expect(repo.purgeExpiredIdempotencyKeysIfDue()).resolves.toBe(0);
    });
  });
});
