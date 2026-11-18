const request = require('supertest');
const { createApp } = require('../app');
const { AnaliticaEmbedClient, DEFAULT_EMBED_URL } = require('../services/analitica-embed');
const { UnauthorizedError } = require('../errors/app-errors');

const mockKafka = { publishEvent: async () => {}, checkHealth: async () => false };
const mockRepo = {};

const HTML = '<!doctype html><html><script id="citypass-datos" type="application/json">{}</script></html>';

function headerMap(entries) {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) };
}

function appWith(user, fetchImpl) {
  const authenticate = (req, res, next) => {
    if (!req.headers.authorization) {
      next(new UnauthorizedError('Falta el header Authorization'));
      return;
    }
    req.user = user;
    next();
  };
  return createApp(mockKafka, mockRepo, {
    authenticate,
    analiticaClient: new AnaliticaEmbedClient({
      embedUrl: 'https://analitica.test/embed/emergencias',
      fetch: fetchImpl,
    }),
  });
}

describe('GET /admin/analitica', () => {
  it('reenvia el Bearer y devuelve el HTML de Analítica sin cache ni X-Frame-Options', async () => {
    const calls = [];
    const app = appWith({ sub: 'U1', groups: ['dispatcher'] }, async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        status: 200,
        headers: headerMap({
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'content-security-policy': "default-src 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        }),
        text: async () => HTML,
      };
    });

    const res = await request(app)
      .get('/admin/analitica')
      .set('Authorization', 'Bearer human-token')
      .expect(200);

    expect(res.text).toBe(HTML);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://analitica.test/embed/emergencias');
    expect(calls[0].url).not.toContain('human-token');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer human-token');
    expect(calls[0].init.headers.Accept).toBe('text/html');
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('pone Cache-Control no-store si Analítica no lo manda', async () => {
    const app = appWith({ sub: 'U1', groups: ['dispatcher'] }, async () => ({
      status: 200,
      headers: headerMap({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => HTML,
    }));

    const res = await request(app)
      .get('/admin/analitica')
      .set('Authorization', 'Bearer human-token')
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('deja pasar el status y el body cuando Analítica rechaza el token', async () => {
    const app = appWith({ sub: 'U1', groups: ['dispatcher'] }, async () => ({
      status: 401,
      headers: headerMap({ 'content-type': 'application/json' }),
      text: async () => '{"error":"invalid token"}',
    }));

    const res = await request(app)
      .get('/admin/analitica')
      .set('Authorization', 'Bearer human-token')
      .expect(401);

    expect(res.text).toBe('{"error":"invalid token"}');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('responde 403 si el usuario no es dispatcher', async () => {
    const app = appWith({ sub: 'U2', groups: ['citizen'] }, async () => {
      throw new Error('no debe llamarse');
    });

    const res = await request(app)
      .get('/admin/analitica')
      .set('Authorization', 'Bearer human-token')
      .expect(403);

    expect(res.body.error).toBe('ForbiddenError');
  });

  it('responde 401 sin Authorization', async () => {
    const app = appWith({ sub: 'U1', groups: ['dispatcher'] }, async () => {
      throw new Error('no debe llamarse');
    });

    const res = await request(app).get('/admin/analitica').expect(401);
    expect(res.body.error).toBe('UnauthorizedError');
  });

  it('responde 503 si Analítica no responde', async () => {
    const app = appWith({ sub: 'U1', groups: ['dispatcher'] }, async () => {
      const err = new Error('socket hang up');
      err.name = 'AbortError';
      throw err;
    });

    const res = await request(app)
      .get('/admin/analitica')
      .set('Authorization', 'Bearer human-token')
      .expect(503);

    // Los 5xx salen genéricos: el detalle queda en el log, no en el body.
    expect(res.body).toEqual({ error: 'InternalServerError', message: 'Error interno' });
  });
});

describe('AnaliticaEmbedClient', () => {
  it('usa la URL de producción de Emergencias si no hay override', () => {
    const previous = process.env.ANALITICA_EMBED_URL;
    delete process.env.ANALITICA_EMBED_URL;
    try {
      expect(new AnaliticaEmbedClient().embedUrl).toBe(DEFAULT_EMBED_URL);
      expect(DEFAULT_EMBED_URL).toBe(
        'https://citypass-backend-prod-becqetepcjbqa8c7.brazilsouth-01.azurewebsites.net/embed/emergencias'
      );
    } finally {
      if (previous === undefined) delete process.env.ANALITICA_EMBED_URL;
      else process.env.ANALITICA_EMBED_URL = previous;
    }
  });

  it('rechaza una URL que no es https', async () => {
    const client = new AnaliticaEmbedClient({
      embedUrl: 'http://analitica.test/embed/emergencias',
      fetch: async () => { throw new Error('no debe llamarse'); },
    });
    await expect(client.fetchDashboard('tok')).rejects.toMatchObject({ statusCode: 503 });
  });
});
