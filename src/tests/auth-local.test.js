const request = require('supertest');
const { createAuthSetup } = require('../auth/setup');
const { createApp } = require('../app');

const mockKafka = {
  publishEvent: async () => {},
  checkHealth: async () => false,
};

const mockRepo = {
  create: async (e) => ({ ...e, locationAnonymized: false }),
  findById: async (id) => (id ? { id, userId: 'U000042', status: 'CREATED', locationAnonymized: false } : null),
  findAll: async () => [],
  recordAccess: async () => ({}),
  updateStatus: async (id, { newStatus, actor, reason }) => ({
    emergency: { id, status: newStatus, userId: actor, locationAnonymized: false },
    history: { previousStatus: 'CREATED', newStatus, actor, reason },
  }),
};

describe('AUTH_MODE=local', () => {
  let app;

  beforeAll(async () => {
    const auth = await createAuthSetup({
      env: {
        AUTH_MODE: 'local',
        NODE_ENV: 'test',
        IDP_ISSUER: 'https://idp.citypass.local',
        IDP_AUDIENCE: 'citypass-emergencias-api',
        IDP_MODULE: 'emergencias',
        LOCAL_TOKEN_TTL_SECONDS: 900,
      },
    });

    app = createApp(mockKafka, mockRepo, {
      authenticate: auth.authenticate,
      devAuthRouter: auth.devAuthRouter,
      authMode: auth.mode,
    });
  });

  it('exposes POST /auth/dev/login and returns access_token', async () => {
    const login = await request(app)
      .post('/auth/dev/login')
      .send({
        sub: 'U000042',
        preferred_username: 'jperez',
        groups: ['citizen'],
      })
      .expect(200);

    expect(login.body.access_token).toBeDefined();
    expect(login.body.token_type).toBe('Bearer');
    expect(login.body.expires_in).toBe(900);
  });

  it('accepts dev token on protected endpoints end-to-end', async () => {
    const login = await request(app)
      .post('/auth/dev/login')
      .send({ sub: 'U000099', groups: ['citizen'] })
      .expect(200);

    const panic = await request(app)
      .post('/api/panic-button')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .send({
        location: { latitude: -34.6, longitude: -58.4 },
      })
      .expect(201);

    expect(panic.body.data.userId).toBe('U000099');
  });

  it('reports authMode=local on /health', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.authMode).toBe('local');
  });

  it('rejects dev login without sub', async () => {
    const res = await request(app)
      .post('/auth/dev/login')
      .send({ preferred_username: 'jperez' })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });
});

describe('loadAuthConfig', () => {
  const { loadAuthConfig } = require('../auth/config');

  it('requires IDP vars when AUTH_MODE=idp', () => {
    expect(() => loadAuthConfig({
      AUTH_MODE: 'idp',
      NODE_ENV: 'test',
    })).toThrow(/IDP_ISSUER/);
  });

  it('blocks local mode in production without ALLOW_LOCAL_AUTH', () => {
    expect(() => loadAuthConfig({
      AUTH_MODE: 'local',
      NODE_ENV: 'production',
    })).toThrow(/not allowed/);
  });

  it('allows local mode in production when ALLOW_LOCAL_AUTH=true (staging)', () => {
    const config = loadAuthConfig({
      AUTH_MODE: 'local',
      NODE_ENV: 'production',
      ALLOW_LOCAL_AUTH: 'true',
    });
    expect(config.mode).toBe('local');
  });
});
