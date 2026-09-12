const express = require('express');
const request = require('supertest');
const {
  isRateLimitEnabled,
  createPanicButtonRateLimiter,
  createDevLoginRateLimiter,
} = require('../security/rate-limit');

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
