const fs = require('fs');
const os = require('os');
const path = require('path');

const script = require('../../scripts/register-event-types');

describe('register-event-types script', () => {
  describe('requireEnv()', () => {
    it('no lanza si estan las 4 variables', () => {
      expect(() => script.requireEnv({
        EDA_API_URL: 'x',
        EDA_AUTH_URL: 'x',
        EDA_CLIENT_ID: 'x',
        EDA_CLIENT_SECRET: 'x',
      })).not.toThrow();
    });

    it('lanza listando las variables faltantes', () => {
      expect(() => script.requireEnv({})).toThrow(/EDA_API_URL/);
      expect(() => script.requireEnv({ EDA_API_URL: 'x', EDA_AUTH_URL: 'x' })).toThrow(/EDA_CLIENT_ID.*EDA_CLIENT_SECRET/);
    });
  });

  describe('listSchemaFiles()', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eda-schemas-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('devuelve [] si el directorio no existe', () => {
      expect(script.listSchemaFiles(path.join(tmpDir, 'nope'))).toEqual([]);
    });

    it('ignora archivos .draft y otros, solo matchea *.avsc.json', () => {
      fs.writeFileSync(path.join(tmpDir, 'A.avsc.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'B.avsc.json.draft'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# docs');
      fs.writeFileSync(path.join(tmpDir, 'C.avsc.json'), '{}');

      const result = script.listSchemaFiles(tmpDir).map((p) => path.basename(p));
      expect(result).toEqual(['A.avsc.json', 'C.avsc.json']);
    });
  });

  describe('isAlreadyExistsResponse()', () => {
    it('false para status != 400', () => {
      expect(script.isAlreadyExistsResponse(200, 'Existe un event type')).toBe(false);
      expect(script.isAlreadyExistsResponse(500, 'already exists')).toBe(false);
    });

    it('true para 400 con mensaje reconocible (string o json)', () => {
      expect(script.isAlreadyExistsResponse(400, 'Existe un event type con ese fqn')).toBe(true);
      expect(script.isAlreadyExistsResponse(400, 'The schema already exists.')).toBe(true);
      expect(script.isAlreadyExistsResponse(400, 'duplicate name')).toBe(true);
      expect(script.isAlreadyExistsResponse(400, { detail: 'Existe un event type' })).toBe(true);
    });

    it('false para 400 de otra naturaleza', () => {
      expect(script.isAlreadyExistsResponse(400, 'Invalid Avro schema')).toBe(false);
      expect(script.isAlreadyExistsResponse(400, '')).toBe(false);
    });
  });

  describe('getToken()', () => {
    it('devuelve access_token con Basic Auth en header y body form-encoded', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-123' }),
      });
      const token = await script.getToken({
        authUrl: 'https://gw/oauth/token',
        clientId: 'grupo5',
        clientSecret: 'grupo5',
        fetchImpl,
      });
      expect(token).toBe('tok-123');
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://gw/oauth/token');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('grupo5:grupo5').toString('base64')}`);
      expect(init.body).toBe('grant_type=client_credentials');
    });

    it('lanza si la respuesta no es ok', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'invalid_client',
      });
      await expect(script.getToken({
        authUrl: 'x', clientId: 'x', clientSecret: 'x', fetchImpl,
      })).rejects.toThrow(/Auth fallo \(401\)/);
    });

    it('lanza si falta access_token', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
      await expect(script.getToken({
        authUrl: 'x', clientId: 'x', clientSecret: 'x', fetchImpl,
      })).rejects.toThrow(/sin access_token/);
    });
  });

  describe('registerSchema()', () => {
    let tmpFile;

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), `EmergenciaReportada.avsc.json`);
      fs.writeFileSync(tmpFile, JSON.stringify({ name: 'EmergenciaReportada', fields: [] }));
    });

    afterEach(() => {
      try { fs.unlinkSync(tmpFile); } catch (_) { /* noop */ }
    });

    it('registra con Bearer en /api/v1/event-types y status OK para 2xx', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        status: 201,
        text: async () => '{}',
      });
      const result = await script.registerSchema({
        apiUrl: 'https://gw.example.com/',
        token: 'tok-abc',
        filePath: tmpFile,
        fetchImpl,
      });
      expect(result).toEqual({ name: 'EmergenciaReportada', status: 'OK', httpCode: 201 });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://gw.example.com/api/v1/event-types');
      expect(init.headers.Authorization).toBe('Bearer tok-abc');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ name: 'EmergenciaReportada', fields: [] });
    });

    it('status ALREADY_EXISTS para 400 reconocible', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        status: 400,
        text: async () => 'Existe un event type con ese fqn',
      });
      const result = await script.registerSchema({
        apiUrl: 'https://gw.example.com',
        token: 'tok',
        filePath: tmpFile,
        fetchImpl,
      });
      expect(result.status).toBe('ALREADY_EXISTS');
    });

    it('lanza para 400 que no sea de duplicado', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        status: 400,
        text: async () => 'Invalid Avro schema',
      });
      await expect(script.registerSchema({
        apiUrl: 'https://gw.example.com',
        token: 'tok',
        filePath: tmpFile,
        fetchImpl,
      })).rejects.toThrow(/400/);
    });

    it('lanza para otros errores con httpCode y body en el error', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        status: 502,
        text: async () => 'Schema Registry no responde',
      });
      const err = await script.registerSchema({
        apiUrl: 'https://gw.example.com',
        token: 'tok',
        filePath: tmpFile,
        fetchImpl,
      }).catch((e) => e);
      expect(err.httpCode).toBe(502);
      expect(err.body).toMatch(/Schema Registry/);
    });

    it('normaliza trailing slash en apiUrl', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({ status: 201, text: async () => '' });
      await script.registerSchema({
        apiUrl: 'https://gw.example.com///',
        token: 'tok',
        filePath: tmpFile,
        fetchImpl,
      });
      const [url] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://gw.example.com/api/v1/event-types');
    });
  });
});
