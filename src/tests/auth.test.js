const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const request = require('supertest');
const { createJwtVerifier } = require('../auth/jwt-verifier');
const { createAuthenticateMiddleware } = require('../auth/authenticate');
const { createApp } = require('../app');
const { UnauthorizedError } = require('../errors/app-errors');

const ISSUER = 'https://idp.citypass.local';
const AUDIENCE = 'citypass-emergencias-api';
const CLOCK_TOLERANCE = 60;

const baseConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: 'https://idp.citypass.local/.well-known/jwks.json',
  clockTolerance: CLOCK_TOLERANCE,
  expectedTokenUse: 'human',
  expectedVer: 1,
};

let privateKey;
let publicJwk;
let jwks;
let verifyAccessToken;

async function signToken(claims, { alg = 'RS256', kid = 'test-key', header = {} } = {}) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg, kid, ...header })
    .setIssuedAt(claims.iat ?? Math.floor(Date.now() / 1000))
    .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 900);

  if (claims.iss === undefined) jwt.setIssuer(ISSUER);
  if (claims.aud === undefined) jwt.setAudience([AUDIENCE]);
  if (claims.sub === undefined) jwt.setSubject('U000042');

  return jwt.sign(privateKey);
}

function validClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: 'U000042',
    aud: [AUDIENCE],
    token_use: 'human',
    ver: 1,
    preferred_username: 'jperez',
    module: 'emergencias',
    groups: ['citizen'],
    iat: now,
    exp: now + 900,
    jti: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    ...overrides,
  };
}

beforeAll(async () => {
  const { privateKey: priv, publicKey } = await generateKeyPair('RS256');
  privateKey = priv;
  publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [publicJwk] });
  ({ verifyAccessToken } = createJwtVerifier(baseConfig, jwks));
});

describe('createJwtVerifier', () => {
  it('accepts a valid human access token', async () => {
    const token = await signToken(validClaims());
    const user = await verifyAccessToken(token);

    expect(user).toMatchObject({
      sub: 'U000042',
      username: 'jperez',
      groups: ['citizen'],
      module: 'emergencias',
      jti: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      tokenUse: 'human',
    });
  });

  it('accepts empty groups', async () => {
    const token = await signToken(validClaims({ groups: [] }));
    const user = await verifyAccessToken(token);
    expect(user.groups).toEqual([]);
  });

  it('rejects expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(validClaims({ iat: now - 2000, exp: now - 1000 }));
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects wrong audience', async () => {
    const token = await signToken(validClaims({ aud: ['citypass-other-api'] }));
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects aud as string instead of array', async () => {
    const token = await signToken(validClaims({ aud: AUDIENCE }));
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      name: 'UnauthorizedError',
      message: 'Invalid token audience claim',
    });
  });

  it('rejects wrong issuer', async () => {
    const token = await signToken(validClaims({ iss: 'https://evil.example' }));
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects service token_use on human endpoints', async () => {
    const token = await signToken(validClaims({ token_use: 'service' }));
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      name: 'UnauthorizedError',
      message: 'Invalid token_use',
    });
  });

  it('rejects unsupported ver', async () => {
    const token = await signToken(validClaims({ ver: 2 }));
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects invalid signature (wrong key)', async () => {
    const { privateKey: otherPriv } = await generateKeyPair('RS256');
    const token = await new SignJWT(validClaims())
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience([AUDIENCE])
      .setSubject('U000042')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(otherPriv);

    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('createAuthenticateMiddleware (HTTP)', () => {
  const mockKafka = {
    publishEvent: async () => {},
    checkHealth: async () => false,
  };
const mockRepo = {
  create: async (e) => ({ ...e, locationAnonymized: false }),
  findById: async () => null,
  findAll: async () => [],
  recordAccess: async () => ({}),
  updateStatus: async () => {
    throw new Error('not used');
  },
};

  let app;

  beforeAll(() => {
    const authenticate = createAuthenticateMiddleware({
      config: baseConfig,
      jwks,
    });
    app = createApp(mockKafka, mockRepo, { authenticate });
  });

  it('returns 401 without Authorization header', async () => {
    const res = await request(app)
      .post('/api/panic-button')
      .send({ location: { latitude: 1, longitude: 2 } })
      .expect(401);

    expect(res.body.error).toBe('UnauthorizedError');
  });

  it('returns 401 with malformed Authorization header', async () => {
    const res = await request(app)
      .post('/api/panic-button')
      .set('Authorization', 'Token abc')
      .send({ location: { latitude: 1, longitude: 2 } })
      .expect(401);

    expect(res.body.error).toBe('UnauthorizedError');
  });

  it('returns 401 with invalid JWT', async () => {
    const res = await request(app)
      .post('/api/panic-button')
      .set('Authorization', 'Bearer not-a-jwt')
      .send({ location: { latitude: 1, longitude: 2 } })
      .expect(401);

    expect(res.body.error).toBe('UnauthorizedError');
  });

  it('allows request with valid Bearer token and sets identity from sub', async () => {
    const token = await signToken(validClaims({ sub: 'U000099' }));

    const res = await request(app)
      .post('/api/panic-button')
      .set('Authorization', `Bearer ${token}`)
      .send({
        location: { latitude: -34.6, longitude: -58.4 },
        description: 'auth ok',
      })
      .expect(201);

    expect(res.body.data.userId).toBe('U000099');
  });

  it('leaves /health public', async () => {
    await request(app).get('/health').expect(200);
  });
});
