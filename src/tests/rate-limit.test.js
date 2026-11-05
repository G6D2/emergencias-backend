const express = require('express');
const request = require('supertest');
const {
  isRateLimitEnabled,
  createPanicButtonRateLimiter,
  createPanicButtonIpRateLimiter,
  createDevLoginRateLimiter,
  createAuthLoginRateLimiter,
  createAuthRegisterRateLimiter,
} = require('../security/rate-limit');
const { createApp } = require('../app');
const { createDevAuthRoutes } = require('../routes/dev-auth.routes');
const { UnauthorizedError } = require('../errors/app-errors');

describe('isRateLimitEnabled', () => {
  it('is enabled by default (no RATE_LIMIT_ENABLED set)', () => {
    expect(isRateLimitEnabled({})).toBe(true);
  });

  it('is disabled only when RATE_LIMIT_ENABLED=false', () => {
    expect(isRateLimitEnabled({ RATE_LIMIT_ENABLED: 'false' })).toBe(false);
  });

  it('stays enabled for any other value', () => {
    expect(isRateLimitEnabled({ RATE_LIMIT_ENABLED: 'true' })).toBe(true);
    expect(isRateLimitEnabled({ RATE_LIMIT_ENABLED: 'nope' })).toBe(true);
  });
});

function buildApp(limiter) {
  const app = express();
  app.get('/ping', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

describe('rate limiters', () => {
  it('let requests through untouched when RATE_LIMIT_ENABLED=false (used in tests)', async () => {
    const limiter = createPanicButtonRateLimiter({ RATE_LIMIT_ENABLED: 'false' });
    const app = buildApp(limiter);

    for (let i = 0; i < 10; i += 1) {
      await request(app).get('/ping').expect(200);
    }
  });

  it('panic-button limiter (5/min): returns 429 with a sanitized body past the limit', async () => {
    const limiter = createPanicButtonRateLimiter({ RATE_LIMIT_ENABLED: 'true' });
    const app = buildApp(limiter);

    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/ping').expect(200);
    }

    const response = await request(app).get('/ping').expect(429);
    expect(response.body).toEqual({
      error: 'TooManyRequests',
      message: expect.any(String),
    });
  });

  it('dev-login limiter (10/min): returns 429 past the limit', async () => {
    const limiter = createDevLoginRateLimiter({ RATE_LIMIT_ENABLED: 'true' });
    const app = buildApp(limiter);

    for (let i = 0; i < 10; i += 1) {
      await request(app).get('/ping').expect(200);
    }

    const response = await request(app).get('/ping').expect(429);
    expect(response.body.error).toBe('TooManyRequests');
  });

  it('gives each limiter instance (one per createApp call) its own in-memory store', async () => {
    const appA = buildApp(createPanicButtonRateLimiter({ RATE_LIMIT_ENABLED: 'true' }));
    const appB = buildApp(createPanicButtonRateLimiter({ RATE_LIMIT_ENABLED: 'true' }));

    for (let i = 0; i < 5; i += 1) {
      await request(appA).get('/ping').expect(200);
    }
    await request(appA).get('/ping').expect(429);

    // appB's limiter is a separate instance: same IP, but its own budget.
    await request(appB).get('/ping').expect(200);
  });
});

describe('per-user and per-IP budgets', () => {
  function buildUserApp(limiter, statusFor = () => 200) {
    const app = express();
    app.use((req, res, next) => {
      req.user = { sub: req.get('x-test-user') };
      next();
    });
    app.post('/panic', limiter, (req, res) => res.status(statusFor(req)).json({}));
    return app;
  }

  it('panic-button limiter keys by req.user.sub: one citizen hitting the limit does not block another behind the same IP (BFF)', async () => {
    const app = buildUserApp(createPanicButtonRateLimiter({ RATE_LIMIT_ENABLED: 'true' }));

    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/panic').set('x-test-user', 'CIT-a').expect(200);
    }
    await request(app).post('/panic').set('x-test-user', 'CIT-a').expect(429);
    await request(app).post('/panic').set('x-test-user', 'CIT-b').expect(200);
  });

  it('panic-button limiter does not count failed requests (skipFailedRequests)', async () => {
    const app = buildUserApp(
      createPanicButtonRateLimiter({ RATE_LIMIT_ENABLED: 'true' }),
      (req) => (req.get('x-fail') ? 503 : 201)
    );

    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/panic').set('x-test-user', 'CIT-a').set('x-fail', '1').expect(503);
    }
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/panic').set('x-test-user', 'CIT-a').expect(201);
    }
    await request(app).post('/panic').set('x-test-user', 'CIT-a').expect(429);
  });

  it('panic-button IP limiter is a much wider net (300/min) than the per-citizen budget', async () => {
    const app = buildApp(createPanicButtonIpRateLimiter({ RATE_LIMIT_ENABLED: 'true' }));

    for (let i = 0; i < 30; i += 1) {
      await request(app).get('/ping').expect(200);
    }
    const response = await request(app).get('/ping').expect(200);
    expect(response.headers['ratelimit-limit']).toBe('300');
  });

  it('auth login limiter only counts failed attempts', async () => {
    const app = express();
    app.use(express.json());
    app.post('/login', createAuthLoginRateLimiter({ RATE_LIMIT_ENABLED: 'true' }), (req, res) => {
      res.status(req.body.password === 'ok' ? 200 : 401).json({});
    });

    for (let i = 0; i < 30; i += 1) {
      await request(app).post('/login').send({ password: 'ok' }).expect(200);
    }
    for (let i = 0; i < 20; i += 1) {
      await request(app).post('/login').send({ password: 'mal' }).expect(401);
    }
    await request(app).post('/login').send({ password: 'ok' }).expect(429);
  });

  it('auth register limiter counts successful sign-ups too (no unlimited account creation)', async () => {
    const app = express();
    app.post('/register', createAuthRegisterRateLimiter({ RATE_LIMIT_ENABLED: 'true' }), (req, res) => {
      res.status(201).json({});
    });

    for (let i = 0; i < 20; i += 1) {
      await request(app).post('/register').expect(201);
    }
    await request(app).post('/register').expect(429);
  });
});

describe('route wiring with RATE_LIMIT_ENABLED=true', () => {
  const previous = process.env.RATE_LIMIT_ENABLED;
  const mockKafka = { publishEvent: async () => {}, checkHealth: async () => false };
  const mockRepo = { create: async (e) => ({ ...e, locationAnonymized: false }) };

  beforeAll(() => {
    process.env.RATE_LIMIT_ENABLED = 'true';
  });

  afterAll(() => {
    process.env.RATE_LIMIT_ENABLED = previous;
  });

  it('POST /api/panic-button: requests without token do not spend the citizens\' budget', async () => {
    const authenticate = (req, res, next) => {
      const sub = req.get('x-test-user');
      if (!sub) {
        next(new UnauthorizedError('Missing Authorization header'));
        return;
      }
      req.user = { sub, groups: ['citizen'] };
      next();
    };
    const app = createApp(mockKafka, mockRepo, { authenticate });
    const sos = { location: { latitude: -34.6, longitude: -58.4 } };

    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/api/panic-button').send(sos).expect(401);
    }
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/panic-button').set('x-test-user', 'CIT-a').send(sos).expect(201);
    }
    await request(app).post('/api/panic-button').set('x-test-user', 'CIT-a').send(sos).expect(429);
    await request(app).post('/api/panic-button').set('x-test-user', 'CIT-b').send(sos).expect(201);
  });

  it('POST /auth/login: successful logins do not lock the IP out', async () => {
    const authUserRepository = {
      findByEmail: async (email) => ({
        id: 'u1',
        email,
        passwordHash: 'hash',
        displayName: 'Vecina',
        groups: ['citizen'],
        hasAntipanicButton: true,
      }),
      verifyPassword: async (hash, password) => password === 'secreto12',
    };
    const tokenIssuer = {
      issueAccessToken: async () => ({ access_token: 't', token_type: 'Bearer', expires_in: 900 }),
    };
    const app = createApp(mockKafka, mockRepo, {
      authenticate: (req, res, next) => next(),
      devAuthRouter: createDevAuthRoutes(tokenIssuer, authUserRepository),
    });

    for (let i = 0; i < 25; i += 1) {
      await request(app)
        .post('/auth/login')
        .send({ email: `vecina${i}@example.com`, password: 'secreto12' })
        .expect(200);
    }
  });
});
