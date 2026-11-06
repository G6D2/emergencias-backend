// AUTH_MODE=hybrid de punta a punta: createAuthSetup real, app real y JWT
// RS256 reales. El Login Federado se simula con un par RSA propio y un JWKS en
// memoria (helpers/hybrid-jwt.js); los tokens locales salen del emisor de
// producción. Se mira la identidad que queda en req.user con GET /api/user.

const request = require('supertest');
const { createApp } = require('../app');
const { createHybridVerifier } = require('../auth/hybrid-verifier');
const { createFakeFederatedIdp, createHybridJwtAuth, FEDERATED_ISSUER } = require('./helpers/hybrid-jwt');

const EMERGENCY_ID = '11111111-1111-4111-8111-111111111111';

const mockKafka = {
  isEnabled: () => false,
  publishEvent: async () => {},
  checkHealth: async () => false,
};

function createEmergencyRepository() {
  const emergency = {
    id: EMERGENCY_ID,
    userId: 'CIT-JuanPanico',
    status: 'DISPATCHED',
    severity: 'critical',
    emergencyType: 'PANICO',
    assignedOfficerId: 'of-001',
    locationAnonymized: false,
  };
  return {
    findById: jest.fn(async () => ({ ...emergency })),
    findPage: jest.fn(async () => ({ emergencies: [], total: 0 })),
    recordAccess: jest.fn(async () => ({})),
    updateStatus: jest.fn(async (id, { newStatus, actor }) => ({
      emergency: { ...emergency, status: newStatus },
      history: { previousStatus: emergency.status, newStatus, actor },
    })),
  };
}

function createAuthUsers() {
  const juan = {
    id: 'a1111111-1111-4111-8111-111111111111',
    email: 'juanpanico@gmail.com',
    passwordHash: 'hash-de-prueba',
    displayName: 'JuanPanico',
    groups: ['citizen'],
    hasAntipanicButton: true,
  };
  return {
    findByEmail: jest.fn(async (email) => (email === juan.email ? { ...juan } : null)),
    verifyPassword: jest.fn(async (hash, password) => hash === juan.passwordHash && password === 'abracadabra'),
    create: jest.fn(async ({ email, displayName, groups, hasAntipanicButton }) => ({
      id: 'b2222222-2222-4222-8222-222222222222',
      email,
      displayName: displayName || '',
      groups,
      hasAntipanicButton,
    })),
  };
}

async function buildApp(extraEnv = {}) {
  const hybrid = await createHybridJwtAuth(extraEnv, { authUserRepository: createAuthUsers() });
  const emergencyRepository = createEmergencyRepository();
  const app = createApp(mockKafka, emergencyRepository, {
    authenticate: hybrid.authenticate,
    devAuthRouter: hybrid.devAuthRouter,
  });
  return { ...hybrid, app, emergencyRepository };
}

function me(app, token) {
  return request(app).get('/api/user').set('Authorization', `Bearer ${token}`);
}

describe('AUTH_MODE=hybrid', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await buildApp({ IDP_SUB_ALIASES: JSON.stringify({ U000777: 'of-001' }) });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('token del Login Federado', () => {
    it('acepta un token válido y mapea los grupos', async () => {
      const token = await ctx.federatedToken({ sub: 'U000123', groups: ['dispatcher'] });

      const res = await me(ctx.app, token).expect(200);

      expect(res.body.data).toEqual({
        sub: 'U000123',
        username: 'jperez',
        groups: ['dispatcher'],
        module: 'emergencias',
        authSource: 'federated',
        idpSub: 'U000123',
        idpGroups: ['dispatcher'],
      });
    });

    it('acepta aud como lista con otras audiences adentro', async () => {
      const token = await ctx.federatedToken({ aud: ['citypass', 'citypass-emergencias-api'] });
      await me(ctx.app, token).expect(200);
    });

    it('acepta aud como string', async () => {
      const token = await ctx.federatedToken({ aud: 'citypass-emergencias-api' });
      await me(ctx.app, token).expect(200);
    });

    it.each([
      ['string de otro módulo', 'citypass-reclamos-api'],
      ['lista de otro módulo', ['citypass-reclamos-api']],
      ['lista vacía', []],
    ])('rechaza aud %s', async (label, aud) => {
      const token = await ctx.federatedToken({ aud });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.error).toBe('UnauthorizedError');
    });

    it('compara grupos sin importar mayúsculas', async () => {
      const token = await ctx.federatedToken({ groups: ['DISPATCHERS'] });

      const res = await me(ctx.app, token).expect(200);
      expect(res.body.data.groups).toEqual(['dispatcher']);
      expect(res.body.data.idpGroups).toEqual(['DISPATCHERS']);

      await request(ctx.app)
        .get('/api/emergencies')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    // Nombres que usa el front del #56 (app/lib/auth-roles.js) para el personal.
    it.each([
      [['dispatcher'], ['dispatcher']],
      [['dispatchers'], ['dispatcher']],
      [['operador'], ['dispatcher']],
      [['officer'], ['officer']],
      [['delegado'], ['delegado']],
      [['delegados'], ['delegado']],
    ])('GET /api/user con groups %j del Login Federado → %j', async (idpGroups, groups) => {
      const res = await me(ctx.app, await ctx.federatedToken({ groups: idpGroups })).expect(200);
      expect(res.body.data.groups).toEqual(groups);
      expect(res.body.data.idpGroups).toEqual(idpGroups);
    });

    it('un grupo que el mapa no conoce no otorga nada', async () => {
      const token = await ctx.federatedToken({ groups: ['guardia-finde'] });

      const res = await me(ctx.app, token).expect(200);
      expect(res.body.data.groups).toEqual([]);

      await request(ctx.app)
        .get('/api/emergencies')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('por default no da citizen a un federado', async () => {
      const token = await ctx.federatedToken({ sub: 'CIT-JuanPanico', groups: ['citizen'] });

      const res = await me(ctx.app, token).expect(200);
      expect(res.body.data.groups).toEqual([]);
      await request(ctx.app)
        .get(`/api/emergencies/${EMERGENCY_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('el delegado se informa en /api/user pero no opera', async () => {
      const token = await ctx.federatedToken({ groups: ['delegados'] });

      const res = await me(ctx.app, token).expect(200);
      expect(res.body.data.groups).toEqual(['delegado']);

      await request(ctx.app)
        .get('/api/emergencies')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('acepta groups como string suelto', async () => {
      const token = await ctx.federatedToken({ groups: 'dispatcher' });
      const res = await me(ctx.app, token).expect(200);
      expect(res.body.data.groups).toEqual(['dispatcher']);
    });

    it('rechaza groups con un tipo inválido', async () => {
      const token = await ctx.federatedToken({ groups: { dispatcher: true } });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.message).toBe('Invalid groups claim');
    });

    it('acepta un token sin token_use ni ver (opcionales por default)', async () => {
      const token = await ctx.federatedToken({ token_use: undefined, ver: undefined });
      await me(ctx.app, token).expect(200);
    });

    it('rechaza un token de servicio del mismo IdP', async () => {
      const token = await ctx.federatedToken({ token_use: 'service', groups: undefined });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.message).toBe('Invalid token_use');
    });

    it('rechaza una versión de contrato desconocida', async () => {
      const token = await ctx.federatedToken({ ver: 2 });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.message).toBe('Unsupported token version');
    });

    it('rechaza un token vencido', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await ctx.federatedToken({ iat: now - 3600, exp: now - 1800 });
      await me(ctx.app, token).expect(401);
    });

    it('rechaza un token sin exp', async () => {
      const token = await ctx.federatedToken({ exp: undefined });
      await me(ctx.app, token).expect(401);
    });

    it('rechaza un sub vacío', async () => {
      const token = await ctx.federatedToken({ sub: '   ' });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.message).toBe('Invalid token subject');
    });

    it('rechaza la firma de una clave que no está en el JWKS federado', async () => {
      const other = await createFakeFederatedIdp();
      const token = await other.sign({ groups: ['dispatcher'] });
      await me(ctx.app, token).expect(401);
    });
  });

  describe('alias de oficial (IDP_SUB_ALIASES)', () => {
    it('un oficial federado opera como su id del catálogo', async () => {
      const token = await ctx.federatedToken({ sub: 'U000777', groups: ['officer'] });

      const res = await me(ctx.app, token).expect(200);
      expect(res.body.data).toMatchObject({ sub: 'of-001', idpSub: 'U000777', groups: ['officer'] });

      await request(ctx.app)
        .patch(`/api/emergencies/${EMERGENCY_ID}/en-route`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // La auditoría del cambio de estado guarda el id interno.
      expect(ctx.emergencyRepository.updateStatus).toHaveBeenCalledWith(
        EMERGENCY_ID,
        expect.objectContaining({ newStatus: 'EN_ROUTE', actor: 'of-001', requireAssignedOfficerId: 'of-001' })
      );
    });

    it('un oficial federado sin alias no puede tocar la emergencia de of-001', async () => {
      const token = await ctx.federatedToken({ sub: 'U000778', groups: ['officer'] });

      await request(ctx.app)
        .patch(`/api/emergencies/${EMERGENCY_ID}/en-route`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      expect(ctx.emergencyRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('no se aplica a tokens locales con el mismo sub', async () => {
      const token = await ctx.localToken({ sub: 'U000777', groups: ['officer'] });

      const res = await me(ctx.app, token).expect(200);
      expect(res.body.data.sub).toBe('U000777');
      expect(res.body.data.authSource).toBe('local');
    });
  });

  describe('token local', () => {
    it('acepta el token del dev login con el issuer local', async () => {
      const login = await request(ctx.app)
        .post('/auth/dev/login')
        .send({ sub: 'DISP-Demo001', groups: ['dispatcher'] })
        .expect(200);

      const res = await me(ctx.app, login.body.access_token).expect(200);
      expect(res.body.data).toMatchObject({ sub: 'DISP-Demo001', groups: ['dispatcher'], authSource: 'local' });
      expect(res.body.data).not.toHaveProperty('idpSub');
    });

    it('sigue ofreciendo login y registro de ciudadanos', async () => {
      const login = await request(ctx.app)
        .post('/auth/login')
        .send({ email: 'juanpanico@gmail.com', password: 'abracadabra' })
        .expect(200);

      const res = await me(ctx.app, login.body.access_token).expect(200);
      expect(res.body.data).toMatchObject({
        sub: 'a1111111-1111-4111-8111-111111111111',
        groups: ['citizen'],
        hasAntipanicButton: true,
        authSource: 'local',
      });

      const registered = await request(ctx.app)
        .post('/auth/register')
        .send({ email: 'nueva@example.com', password: 'secreto12' })
        .expect(201);
      await me(ctx.app, registered.body.access_token).expect(200);
    });

    it('emite con iss local, distinto del federado', async () => {
      const token = await ctx.localToken({ sub: 'U1', groups: ['citizen'] });
      const [, payload] = token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      expect(claims.iss).toBe('urn:citypass:emergencias:local');
      expect(claims.iss).not.toBe(FEDERATED_ISSUER);
    });

    it('sigue exigiendo token_use y ver', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await ctx.signLocal({
        iss: ctx.localConfig.issuer,
        sub: 'U1',
        aud: [ctx.localConfig.audience],
        groups: ['citizen'],
        iat: now,
        exp: now + 900,
      });
      await me(ctx.app, token).expect(401);
    });

    it('sigue exigiendo aud como lista', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await ctx.signLocal({
        iss: ctx.localConfig.issuer,
        sub: 'U1',
        aud: ctx.localConfig.audience,
        token_use: 'human',
        ver: 1,
        groups: ['citizen'],
        iat: now,
        exp: now + 900,
      });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.message).toBe('Invalid token audience claim');
    });

    it('un token firmado con la clave local que dice ser federado da 401', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await ctx.signLocal({
        iss: FEDERATED_ISSUER,
        sub: 'U1',
        aud: ['citypass-emergencias-api'],
        token_use: 'human',
        ver: 1,
        groups: ['dispatcher'],
        iat: now,
        exp: now + 900,
      });
      await me(ctx.app, token).expect(401);
    });

    it('un token firmado por el IdP federado que dice ser local da 401', async () => {
      const token = await ctx.federatedToken({ iss: ctx.localConfig.issuer, groups: ['dispatcher'] });
      await me(ctx.app, token).expect(401);
    });
  });

  describe('issuer', () => {
    it('un iss desconocido da 401', async () => {
      const token = await ctx.federatedToken({ iss: 'https://otro-idp.example', groups: ['dispatcher'] });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.message).toBe('Unknown token issuer');
    });

    it('un token sin iss da 401', async () => {
      const token = await ctx.federatedToken({ iss: undefined });
      const res = await me(ctx.app, token).expect(401);
      expect(res.body.message).toBe('Unknown token issuer');
    });

    it('algo que no es un JWT da 401', async () => {
      const res = await me(ctx.app, 'no-es-un-jwt').expect(401);
      expect(res.body.message).toBe('Invalid or expired token');
    });
  });
});

describe('AUTH_MODE=hybrid con claims configurados', () => {
  it('IDP_REQUIRE_TOKEN_USE / IDP_REQUIRE_TOKEN_VER los vuelven obligatorios', async () => {
    const ctx = await buildApp({ IDP_REQUIRE_TOKEN_USE: 'true', IDP_REQUIRE_TOKEN_VER: 'true' });

    await me(ctx.app, await ctx.federatedToken({ token_use: undefined })).expect(401);
    await me(ctx.app, await ctx.federatedToken({ ver: undefined })).expect(401);
    await me(ctx.app, await ctx.federatedToken()).expect(200);
  });

  it('IDP_SUBJECT_CLAIM e IDP_GROUPS_CLAIM leen otros claims', async () => {
    const ctx = await buildApp({
      IDP_SUBJECT_CLAIM: 'preferred_username',
      IDP_GROUPS_CLAIM: 'roles',
      IDP_SUB_ALIASES: JSON.stringify({ 'oficial-gomez': 'of-001' }),
    });
    const token = await ctx.federatedToken({
      sub: 'U000555',
      preferred_username: 'oficial-gomez',
      groups: ['dispatcher'],
      roles: ['officer'],
    });

    const res = await me(ctx.app, token).expect(200);
    expect(res.body.data).toMatchObject({ sub: 'of-001', idpSub: 'oficial-gomez', groups: ['officer'] });
  });

  it('IDP_GROUP_MAP reemplaza el mapa por default', async () => {
    const ctx = await buildApp({
      IDP_GROUP_MAP: JSON.stringify({ 'operadores-911': 'dispatcher', 'agentes-calle': ['officer'] }),
    });

    const mapped = await me(ctx.app, await ctx.federatedToken({ groups: ['operadores-911', 'agentes-calle'] }))
      .expect(200);
    expect(mapped.body.data.groups.sort()).toEqual(['dispatcher', 'officer']);

    // 'dispatcher' estaba en el default, pero el mapa propio no lo nombra.
    const dropped = await me(ctx.app, await ctx.federatedToken({ groups: ['dispatcher'] })).expect(200);
    expect(dropped.body.data.groups).toEqual([]);
  });
});

describe('createHybridVerifier', () => {
  it('no arranca si los dos issuers son iguales', () => {
    const verifyAccessToken = async () => ({});
    expect(() => createHybridVerifier({
      local: { issuer: 'x', verifyAccessToken },
      federated: { issuer: 'x', verifyAccessToken },
    })).toThrow(/different issuers/);
  });
});
