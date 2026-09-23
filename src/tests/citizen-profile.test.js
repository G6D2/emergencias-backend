const request = require('supertest');
const { createApp } = require('../app');
const { createLocationCrypto } = require('../security/location-crypto');
const { CitizenProfileRepository } = require('../repositories/citizen-profile.repository');

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

function stubAuthenticate(user = {
  sub: 'CIT-001',
  groups: ['citizen'],
  username: 'jperez',
}) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

function createMemoryRepo() {
  const cryptoApi = createLocationCrypto(TEST_KEY);
  const profiles = new Map();
  const locations = new Map();

  const repo = new CitizenProfileRepository(
    {
      query: async (sql, params) => {
        if (sql.includes('SELECT COUNT(*)') && sql.includes('citizen_saved_locations')) {
          const count = [...locations.values()].filter((r) => r.user_id === params[0]).length;
          return { rows: [{ count }], rowCount: 1 };
        }
        if (sql.includes('FROM citizen_profiles') && sql.includes('WHERE user_id')) {
          const row = profiles.get(params[0]);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO citizen_profiles')) {
          const row = {
            user_id: params[0],
            display_name: params[1],
            sensitive_encrypted: params[2],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          profiles.set(params[0], row);
          return { rows: [row], rowCount: 1 };
        }
        if (sql.includes('FROM citizen_saved_locations') && sql.includes('ORDER BY')) {
          const rows = [...locations.values()].filter((r) => r.user_id === params[0]);
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('INSERT INTO citizen_saved_locations')) {
          const row = {
            id: params[0],
            user_id: params[1],
            label: params[2],
            location_encrypted: params[3],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          locations.set(params[0], row);
          return { rows: [row], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM citizen_saved_locations')) {
          const row = locations.get(params[0]);
          if (!row || row.user_id !== params[1]) {
            return { rows: [], rowCount: 0 };
          }
          locations.delete(params[0]);
          return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        if (sql.includes('UPDATE citizen_saved_locations')) {
          const row = locations.get(params[0]);
          if (!row || row.user_id !== params[1]) {
            return { rows: [], rowCount: 0 };
          }
          const next = {
            ...row,
            label: params[2],
            location_encrypted: params[3],
            updated_at: new Date().toISOString(),
          };
          locations.set(params[0], next);
          return { rows: [next], rowCount: 1 };
        }
        if (sql.includes('FROM citizen_saved_locations') && sql.includes('AND user_id')) {
          const row = locations.get(params[0]);
          if (!row || row.user_id !== params[1]) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [row], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 80)}`);
      },
    },
    { locationCrypto: cryptoApi }
  );

  return { repo, profiles, locations };
}

function createCitizenApp(user, memory = createMemoryRepo()) {
  return createApp(mockKafkaService, {}, {
    authenticate: stubAuthenticate(user),
    citizenProfileRepository: memory.repo,
  });
}

describe('Citizen profile API', () => {
  it('GET /api/citizen/profile returns empty profile for a new citizen', async () => {
    const app = createCitizenApp();
    const res = await request(app).get('/api/citizen/profile').expect(200);
    expect(res.body.data).toMatchObject({
      name: '',
      phone: '',
      emergencyContactName: '',
      emergencyContactPhone: '',
      medicalCondition: '',
    });
  });

  it('PUT /api/citizen/profile stores sensitive fields encrypted and returns them', async () => {
    const memory = createMemoryRepo();
    const app = createCitizenApp(undefined, memory);
    const payload = {
      name: 'Juan Pérez',
      phone: '1122334455',
      emergencyContactName: 'Ana Pérez',
      emergencyContactPhone: '1199887766',
      medicalCondition: 'Diabetes',
    };
    const putRes = await request(app).put('/api/citizen/profile').send(payload).expect(200);
    expect(putRes.body.data).toMatchObject(payload);

    const stored = memory.profiles.get('CIT-001');
    expect(stored.sensitive_encrypted).toBeTruthy();
    expect(stored.sensitive_encrypted).not.toContain('Diabetes');
    expect(stored.sensitive_encrypted).not.toContain('1122334455');

    const getRes = await request(app).get('/api/citizen/profile').expect(200);
    expect(getRes.body.data).toMatchObject(payload);
  });

  it('rejects profile fields with invalid types', async () => {
    const app = createCitizenApp();
    const res = await request(app)
      .put('/api/citizen/profile')
      .send({ phone: 1122334455 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('forbids dispatcher from citizen profile endpoints', async () => {
    const app = createCitizenApp({ sub: 'D1', groups: ['dispatcher'], username: 'op' });
    await request(app).get('/api/citizen/profile').expect(403);
    await request(app).put('/api/citizen/profile').send({ name: 'X' }).expect(403);
  });

  it('CRUD saved locations for the authenticated citizen', async () => {
    const app = createCitizenApp();

    const created = await request(app)
      .post('/api/citizen/saved-locations')
      .send({ label: 'Casa', address: 'Av. Siempre Viva 742', lat: -34.6, lng: -58.4 })
      .expect(201);

    expect(created.body.data).toMatchObject({
      label: 'Casa',
      address: 'Av. Siempre Viva 742',
      lat: -34.6,
      lng: -58.4,
    });
    expect(created.body.data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const list = await request(app).get('/api/citizen/saved-locations').expect(200);
    expect(list.body.data).toHaveLength(1);

    const id = created.body.data.id;
    const updated = await request(app)
      .patch(`/api/citizen/saved-locations/${id}`)
      .send({ address: 'Calle Nueva 1' })
      .expect(200);
    expect(updated.body.data.address).toBe('Calle Nueva 1');

    await request(app).delete(`/api/citizen/saved-locations/${id}`).expect(200);
    const empty = await request(app).get('/api/citizen/saved-locations').expect(200);
    expect(empty.body.data).toHaveLength(0);
  });

  it('rejects saved location without label/address', async () => {
    const app = createCitizenApp();
    const res = await request(app)
      .post('/api/citizen/saved-locations')
      .send({ label: '', address: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 409 when saved location limit is reached', async () => {
    const { MAX_SAVED_LOCATIONS_PER_USER } = require('../repositories/citizen-profile.repository');
    const app = createCitizenApp();
    for (let i = 0; i < MAX_SAVED_LOCATIONS_PER_USER; i += 1) {
      const created = await request(app)
        .post('/api/citizen/saved-locations')
        .send({ label: `L${i}`, address: `Addr ${i}` });
      expect(created.status).toBe(201);
    }
    const overflow = await request(app)
      .post('/api/citizen/saved-locations')
      .send({ label: 'Overflow', address: 'No room' });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error).toBe('ConflictError');
  });

  it('returns 404 for another user location id', async () => {
    const memory = createMemoryRepo();
    const ownerApp = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate({ sub: 'CIT-A', groups: ['citizen'] }),
      citizenProfileRepository: memory.repo,
    });
    const otherApp = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate({ sub: 'CIT-B', groups: ['citizen'] }),
      citizenProfileRepository: memory.repo,
    });

    const created = await request(ownerApp)
      .post('/api/citizen/saved-locations')
      .send({ label: 'Casa', address: 'A' });
    expect(created.status).toBe(201);

    const hack = await request(otherApp)
      .patch(`/api/citizen/saved-locations/${created.body.data.id}`)
      .send({ address: 'Hack' });
    expect(hack.status).toBe(404);
    expect(hack.body.error).toBe('NotFoundError');
  });
});

describe('encryptJson keyring', () => {
  it('round-trips arbitrary profile payloads', () => {
    const cryptoApi = createLocationCrypto(TEST_KEY);
    const cipher = cryptoApi.encryptJson({ phone: '11', medicalCondition: 'asma' });
    expect(cipher).not.toContain('asma');
    expect(cryptoApi.decryptJson(cipher)).toEqual({ phone: '11', medicalCondition: 'asma' });
  });
});

describe('CitizenProfileRepository constructor', () => {
  it('requires locationCrypto', () => {
    expect(() => new CitizenProfileRepository({ query: async () => ({}) }, {}))
      .toThrow(/locationCrypto/);
  });
});
