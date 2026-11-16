// Un token rechazado responde siempre el mismo 401; la causa (token vencido,
// JWKS caído, firma inválida...) tiene que quedar en el log, sin el token.

const http = require('http');
const request = require('supertest');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, errors } = require('jose');
const { createApp } = require('../app');
const { createAuthSetup } = require('../auth/setup');
const { createAuthenticateMiddleware } = require('../auth/authenticate');
const { createJwtVerifier } = require('../auth/jwt-verifier');
const { createHybridVerifier } = require('../auth/hybrid-verifier');
const { logTokenRejection } = require('../auth/token-rejection-log');
const { UnauthorizedError } = require('../errors/app-errors');
const { createFakeFederatedIdp, generatePkcs8Pem, HYBRID_AUTH_ENV } = require('./helpers/hybrid-jwt');

const ISSUER = 'https://idp.citypass.local';
const AUDIENCE = 'citypass-emergencias-api';
const SUB = 'U000777';
const REJECTED_BODY = { error: 'UnauthorizedError', message: 'Invalid or expired token' };

const baseConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: 'https://idp.citypass.local/.well-known/jwks.json',
  clockTolerance: 0,
  expectedTokenUse: 'human',
  expectedVer: 1,
};

const mockKafka = { isEnabled: () => false, publishEvent: async () => {}, checkHealth: async () => false };
const mockRepo = { findById: async () => null, findPage: async () => ({ emergencies: [], total: 0 }) };

let privateKey;
let jwks;
let warnSpy;

function sign(claims = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    sub: SUB,
    aud: [AUDIENCE],
    token_use: 'human',
    ver: 1,
    preferred_username: 'jperez',
    groups: ['citizen'],
    iat: now,
    exp: now + 900,
    ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
}

function expiredToken(signer = sign) {
  const now = Math.floor(Date.now() / 1000);
  return signer({ iat: now - 2000, exp: now - 1000 });
}

// Líneas "Token rechazado ..." que salieron por console.warn, ya parseadas.
function rejections() {
  return warnSpy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('Token rechazado '))
    .map((line) => JSON.parse(line.slice('Token rechazado '.length)));
}

// Nada de lo que se logueó puede traer el token, sus claims ni el header.
function expectNoTokenInLogs(token) {
  const logged = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
  const [header, payload, signature] = token.split('.');
  expect(logged).not.toContain(token);
  expect(logged).not.toContain(header);
  expect(logged).not.toContain(payload);
  expect(logged).not.toContain(signature);
  expect(logged).not.toContain(SUB);
  expect(logged).not.toContain('jperez');
  expect(logged).not.toMatch(/Bearer/i);
}

function me(app, token) {
  return request(app).get('/api/user').set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  jwks = createLocalJWKSet({ keys: [jwk] });
});

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('logTokenRejection', () => {
  it('loguea solo el verifier, el código y el nombre del error', () => {
    const error = Object.assign(new Error(`el mensaje no se loguea: ${SUB}`), { code: 'ERR_ALGO', claim: 'sub' });
    logTokenRejection('local', error);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('Token rechazado {"verifier":"local","code":"ERR_ALGO","name":"Error"}');
  });

  it('no rompe si lo que se lanzó no es un error', () => {
    expect(() => logTokenRejection('local', undefined)).not.toThrow();
    expect(rejections()).toEqual([{ verifier: 'local' }]);
  });
});

describe('verifier de tokens locales (jwt-verifier)', () => {
  it('un token vencido deja ERR_JWT_EXPIRED en el log y sigue siendo el mismo 401', async () => {
    const { verifyAccessToken } = createJwtVerifier(baseConfig, jwks);
    const token = await expiredToken();

    const rejection = await verifyAccessToken(token).catch((error) => error);

    expect(rejection).toBeInstanceOf(UnauthorizedError);
    expect(rejection.message).toBe('Invalid or expired token');
    expect(rejections()).toEqual([{ verifier: 'local', code: 'ERR_JWT_EXPIRED', name: 'JWTExpired' }]);
    expectNoTokenInLogs(token);
  });

  it('una firma de otra clave se distingue del token vencido', async () => {
    const { verifyAccessToken } = createJwtVerifier(baseConfig, jwks);
    const { privateKey: otherKey } = await generateKeyPair('RS256');

    await expect(verifyAccessToken(await sign({}, otherKey))).rejects.toBeInstanceOf(UnauthorizedError);

    expect(rejections()).toEqual([{
      verifier: 'local',
      code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      name: 'JWSSignatureVerificationFailed',
    }]);
  });

  it('un token válido no loguea ningún rechazo', async () => {
    const { verifyAccessToken } = createJwtVerifier(baseConfig, jwks);

    await expect(verifyAccessToken(await sign())).resolves.toMatchObject({ sub: SUB });

    expect(rejections()).toEqual([]);
  });

  describe('AUTH_MODE=idp contra un JWKS remoto que no responde 200', () => {
    let server;
    let jwksUri;

    beforeAll(async () => {
      // JWKS "caído" en la misma máquina: responde 503 a todo. Escucha como
      // los servidores de supertest (listen(0), sin fijar la dirección): en
      // macOS un listener atado a 127.0.0.1 puede recibir el mismo puerto que
      // el servidor de otro test y quedarse con sus requests.
      server = http.createServer((req, res) => {
        res.statusCode = 503;
        res.end('unavailable');
      });
      await new Promise((resolve) => server.listen(0, resolve));
      jwksUri = `http://127.0.0.1:${server.address().port}/.well-known/jwks.json`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('deja el código de jose en el log, con el verifier idp', async () => {
      const { verifyAccessToken } = createJwtVerifier({ ...baseConfig, mode: 'idp', jwksUri });
      const token = await sign();

      const rejection = await verifyAccessToken(token).catch((error) => error);

      expect(rejection).toBeInstanceOf(UnauthorizedError);
      expect(rejection.message).toBe('Invalid or expired token');
      expect(rejections()).toEqual([{ verifier: 'idp', code: 'ERR_JOSE_GENERIC', name: 'JOSEError' }]);
      expectNoTokenInLogs(token);
    });
  });
});

describe('AUTH_MODE=hybrid (HTTP)', () => {
  let idp;
  let pem;

  // App real con createAuthSetup; `federatedJwks` hace de JWKS del Login Federado.
  async function buildApp(federatedJwks) {
    const auth = await createAuthSetup({
      env: { ...HYBRID_AUTH_ENV, LOCAL_JWT_PRIVATE_KEY_PEM: pem },
      federatedJwks,
    });
    return createApp(mockKafka, mockRepo, { authenticate: auth.authenticate, devAuthRouter: auth.devAuthRouter });
  }

  beforeAll(async () => {
    idp = await createFakeFederatedIdp();
    pem = generatePkcs8Pem();
  });

  it('token federado vencido: 401 de siempre y ERR_JWT_EXPIRED en el log', async () => {
    const app = await buildApp(idp.jwks);
    const token = await expiredToken(idp.sign);

    const res = await me(app, token).expect(401);

    expect(res.body).toEqual(REJECTED_BODY);
    expect(rejections()).toEqual([{ verifier: 'federated', code: 'ERR_JWT_EXPIRED', name: 'JWTExpired' }]);
    expectNoTokenInLogs(token);
  });

  it('el JWKS federado no responde a tiempo: 401 de siempre y ERR_JWKS_TIMEOUT en el log', async () => {
    const app = await buildApp(async () => {
      throw new errors.JWKSTimeout();
    });
    const token = await idp.sign({ sub: SUB });

    const res = await me(app, token).expect(401);

    expect(res.body).toEqual(REJECTED_BODY);
    expect(rejections()).toEqual([{ verifier: 'federated', code: 'ERR_JWKS_TIMEOUT', name: 'JWKSTimeout' }]);
    expectNoTokenInLogs(token);
  });

  it('no se llega al JWKS federado (error de red de Node): queda el código del sistema', async () => {
    const app = await buildApp(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    });

    const res = await me(app, await idp.sign()).expect(401);

    expect(res.body).toEqual(REJECTED_BODY);
    expect(rejections()).toEqual([{ verifier: 'federated', code: 'ECONNREFUSED', name: 'Error' }]);
  });

  it('algo que no es un JWT: lo rechaza el selector por issuer y también queda en el log', async () => {
    const app = await buildApp(idp.jwks);

    const res = await me(app, 'undefined').expect(401);

    expect(res.body).toEqual(REJECTED_BODY);
    expect(rejections()).toEqual([{ verifier: 'hybrid', code: 'ERR_JWT_INVALID', name: 'JWTInvalid' }]);
  });

  it('un token federado válido entra y no loguea ningún rechazo', async () => {
    const app = await buildApp(idp.jwks);

    await me(app, await idp.sign({ groups: ['dispatcher'] })).expect(200);

    expect(rejections()).toEqual([]);
  });
});

describe('createHybridVerifier', () => {
  it('no loguea un rechazo propio cuando delega en el verifier del issuer', async () => {
    const local = { issuer: 'urn:local', verifyAccessToken: jest.fn(async () => ({ sub: SUB })) };
    const federated = { issuer: ISSUER, verifyAccessToken: jest.fn(async () => ({ sub: SUB })) };
    const { verifyAccessToken } = createHybridVerifier({ local, federated });

    await expect(verifyAccessToken(await sign())).resolves.toEqual({ sub: SUB });

    expect(federated.verifyAccessToken).toHaveBeenCalledTimes(1);
    expect(rejections()).toEqual([]);
  });
});

describe('middleware authenticate', () => {
  it('un error inesperado del verifier responde 401 y queda en el log', async () => {
    const authenticate = createAuthenticateMiddleware({
      config: baseConfig,
      verifyAccessToken: async () => {
        throw new TypeError('algo se rompió adentro del verifier');
      },
    });
    const app = createApp(mockKafka, mockRepo, { authenticate });

    const res = await me(app, 'cualquier-cosa').expect(401);

    expect(res.body).toEqual(REJECTED_BODY);
    expect(rejections()).toEqual([{ verifier: 'authenticate', name: 'TypeError' }]);
  });

  it('un UnauthorizedError del verifier pasa tal cual, sin log extra', async () => {
    const authenticate = createAuthenticateMiddleware({
      config: baseConfig,
      verifyAccessToken: async () => {
        throw new UnauthorizedError('Invalid token_use');
      },
    });
    const app = createApp(mockKafka, mockRepo, { authenticate });

    const res = await me(app, 'cualquier-cosa').expect(401);

    expect(res.body).toEqual({ error: 'UnauthorizedError', message: 'Invalid token_use' });
    expect(rejections()).toEqual([]);
  });
});
