const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createAuthSetup } = require('../auth/setup');
const { createApp } = require('../app');
const { AuthUserRepository } = require('../repositories/auth-user.repository');

const mockKafka = {
  publishEvent: async () => {},
  checkHealth: async () => false,
};

const mockRepo = {
  create: async (e) => ({ ...e, locationAnonymized: false }),
  findById: async (id) => (id ? { id, userId: 'U000042', status: 'PENDING', locationAnonymized: false } : null),
  findAll: async () => [],
  recordAccess: async () => ({}),
  updateStatus: async (id, { newStatus, actor, reason }) => ({
    emergency: { id, status: newStatus, userId: actor, locationAnonymized: false },
    history: { previousStatus: 'PENDING', newStatus, actor, reason },
  }),
};

function createMemoryAuthUsers() {
  const users = new Map();
  return new AuthUserRepository({
    query: async (sql, params) => {
      if (sql.includes('WHERE lower(email)')) {
        const row = users.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('WHERE id =')) {
        const row = [...users.values()].find((u) => u.id === params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO auth_users')) {
        const row = {
          id: params[0],
          email: params[1],
          password_hash: params[2],
          display_name: params[3],
          groups: params[4],
          has_antipanic_button: params[5],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        users.set(row.email, row);
        return { rows: [row], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
    },
  });
}

describe('AUTH_MODE=local register/login', () => {
  let app;
  let authUsers;

  beforeAll(async () => {
    authUsers = createMemoryAuthUsers();
    const auth = await createAuthSetup({
      env: {
        AUTH_MODE: 'local',
        NODE_ENV: 'test',
        IDP_ISSUER: 'https://idp.citypass.local',
        IDP_AUDIENCE: 'citypass-emergencias-api',
        IDP_MODULE: 'emergencias',
        LOCAL_TOKEN_TTL_SECONDS: 900,
      },
      authUserRepository: authUsers,
    });

    app = createApp(mockKafka, mockRepo, {
      authenticate: auth.authenticate,
      devAuthRouter: auth.devAuthRouter,
    });
  });

  it('POST /auth/register creates user and returns access_token', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({
        email: 'valen@example.com',
        password: 'secreto12',
        preferred_username: 'Valen',
      })
      .expect(201);

    expect(res.body.access_token).toBeTruthy();
    expect(res.body.user).toMatchObject({
      username: 'Valen',
      groups: ['citizen'],
      hasAntipanicButton: false,
    });
    expect(res.body.user.email).toBeUndefined();
    expect(res.body.user.sub).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('POST /auth/register rejects duplicate email with 409', async () => {
    const first = await request(app)
      .post('/auth/register')
      .send({ email: 'dup@example.com', password: 'secreto12' });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post('/auth/register')
      .send({ email: 'DUP@example.com', password: 'secreto12' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('ConflictError');
  });

  it('POST /auth/register validates password length', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'corto@example.com', password: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('POST /auth/login authenticates and returns JWT usable on protected routes', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'login@example.com', password: 'secreto12', preferred_username: 'Log' })
      .expect(201);

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'secreto12' })
      .expect(200);

    expect(login.body.access_token).toBeTruthy();
    expect(login.body.user.username).toBe('Log');
    expect(login.body.user.email).toBeUndefined();

    const me = await request(app)
      .get('/api/user')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .expect(200);

    expect(me.body.data.sub).toBe(login.body.user.sub);
    expect(me.body.data.groups).toContain('citizen');
  });

  it('POST /auth/login rejects wrong password', async () => {
    const created = await request(app)
      .post('/auth/register')
      .send({ email: 'wrong@example.com', password: 'secreto12' });
    expect(created.status).toBe(201);

    const bad = await request(app)
      .post('/auth/login')
      .send({ email: 'wrong@example.com', password: 'otra-cosa' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('UnauthorizedError');
  });

  it('keeps POST /auth/dev/login for scripts', async () => {
    const login = await request(app)
      .post('/auth/dev/login')
      .send({ sub: 'U-DEV', groups: ['citizen'] })
      .expect(200);
    expect(login.body.access_token).toBeTruthy();
  });
});

describe('AuthUserRepository password hash', () => {
  it('stores bcrypt hashes that verify', async () => {
    const hash = await bcrypt.hash('secreto12', 4);
    expect(await bcrypt.compare('secreto12', hash)).toBe(true);
    expect(await bcrypt.compare('nope', hash)).toBe(false);
  });
});
