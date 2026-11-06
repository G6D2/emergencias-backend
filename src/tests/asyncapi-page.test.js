const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createApp } = require('../app');
const { createAsyncApiRoutes, VIEWER_VERSION } = require('../routes/asyncapi.routes');

const SPEC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'asyncapi.yaml'), 'utf8');

describe('pagina AsyncAPI', () => {
  const app = createApp(null, {}, { authenticate: (req, res, next) => next() });

  it('GET /asyncapi.yaml sirve el spec del repo sin autenticacion', async () => {
    const res = await request(app).get('/asyncapi.yaml');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/yaml/);
    expect(res.text).toBe(SPEC);
  });

  it.each(['/asyncapi', '/asyncapi/'])('GET %s sirve el viewer apuntando al spec', async (url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain(`@asyncapi/react-component@${VIEWER_VERSION}/browser/standalone/index.js`);
    expect(res.text).toContain("schema: { url: '/asyncapi.yaml' }");
  });

  it('pasa el error al handler si el spec no existe', async () => {
    const standalone = express();
    standalone.use(createAsyncApiRoutes({ specPath: '/no/existe/asyncapi.yaml' }));
    // eslint-disable-next-line no-unused-vars
    standalone.use((err, req, res, next) => res.status(500).json({ error: 'spec' }));

    const res = await request(standalone).get('/asyncapi.yaml');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'spec' });
  });
});
