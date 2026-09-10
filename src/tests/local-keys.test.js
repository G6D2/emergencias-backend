const { generateKeyPairSync } = require('crypto');
const { SignJWT, jwtVerify, createLocalJWKSet } = require('jose');
const { createLocalKeySet, LOCAL_KEY_ID } = require('../auth/local-keys');

describe('createLocalKeySet con LOCAL_JWT_PRIVATE_KEY_PEM', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  it('publica solo la clave pública en el JWK (sin componentes privados)', async () => {
    const keys = await createLocalKeySet(pem);
    expect(keys.publicJwk.kty).toBe('RSA');
    expect(keys.publicJwk.n).toBeDefined();
    for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(keys.publicJwk[priv]).toBeUndefined();
    }
    expect(keys.kid).toBe(LOCAL_KEY_ID);
  });

  it('un token firmado con la PEM se verifica contra el JWKS derivado', async () => {
    const keys = await createLocalKeySet(pem);
    const token = await new SignJWT({ sub: 'U1' })
      .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    const jwks = createLocalJWKSet({ keys: [keys.publicJwk] });
    const { payload } = await jwtVerify(token, jwks);
    expect(payload.sub).toBe('U1');
  });

  it('la misma PEM en dos arranques produce el mismo JWK público', async () => {
    const a = await createLocalKeySet(pem);
    const b = await createLocalKeySet(pem);
    expect(a.publicJwk.n).toBe(b.publicJwk.n);
  });
});
