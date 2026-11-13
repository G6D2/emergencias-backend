// Matriz de autorización: cada endpoint protegido de src/routes contra cada
// identidad posible, con JWT RS256 real (authenticate de createAuthSetup, sin
// stub) y repositorios mockeados. La fuente de verdad del resultado esperado
// es el middleware de grupos de src/auth/authorize.js:
//   - sin token                          → 401
//   - grupo no habilitado para la ruta   → 403, sin tocar ningún repositorio
//   - grupo habilitado                   → ni 401 ni 403 (y sin 5xx)
//
// Un test de inventario recorre las rutas montadas en la app: si alguien
// agrega un endpoint y no lo suma acá, la suite falla.
//
// La matriz corre dos veces: con AUTH_MODE=local (como producción hoy) y con
// AUTH_MODE=hybrid, donde conviven tokens locales y del Login Federado (IdP
// simulado con un JWKS en memoria, ver helpers/hybrid-jwt.js).

const { generateKeyPairSync } = require('crypto');
const request = require('supertest');
const { createApp } = require('../app');
const { createLocalKeySet } = require('../auth/local-keys');
const { createLocalTokenIssuer } = require('../auth/local-token-issuer');
const { createLocalJwtAuth } = require('./helpers/local-jwt');
const { createFakeFederatedIdp, createHybridJwtAuth } = require('./helpers/hybrid-jwt');

const ID = '11111111-1111-4111-8111-111111111111';
const ANY_AUTHENTICATED = 'cualquier token válido';

// [método, ruta tal cual está montada, grupos habilitados, body opcional]
const ENDPOINTS = [
  ['GET', '/api/user', ANY_AUTHENTICATED],
  ['POST', '/api/panic-button', ['citizen'], { location: { latitude: -34.6, longitude: -58.4 } }],
  ['GET', '/api/panic-button/:id', ['citizen', 'dispatcher']],
  ['GET', '/api/emergencies', ['citizen', 'dispatcher', 'officer']],
  ['GET', '/api/emergencies/:id', ['citizen', 'dispatcher']],
  ['PATCH', '/api/emergencies/:id/validate', ['dispatcher']],
  ['PATCH', '/api/emergencies/:id/discard', ['dispatcher'], { reason: 'duplicada' }],
  ['PATCH', '/api/emergencies/:id/assign', ['dispatcher'], { officerId: 'of-001' }],
  ['PATCH', '/api/emergencies/:id/close', ['dispatcher']],
  ['PATCH', '/api/emergencies/:id/return', ['dispatcher'], { reason: 'reasignar' }],
  ['PATCH', '/api/emergencies/:id/en-route', ['officer']],
  ['PATCH', '/api/emergencies/:id/on-scene', ['officer']],
  ['PATCH', '/api/emergencies/:id/resolve', ['officer']],
  ['PATCH', '/api/emergencies/:id/cancel', ['citizen'], { reason: 'falsa alarma' }],
  ['GET', '/api/outbox-events', ['dispatcher']],
  ['GET', '/api/officers', ['dispatcher']],
  ['GET', '/api/incidents', ['dispatcher']],
  ['GET', '/api/incidents/:id', ['dispatcher']],
  ['GET', '/api/citizen/profile', ['citizen']],
  ['PUT', '/api/citizen/profile', ['citizen'], { name: 'Ana' }],
  ['GET', '/api/citizen/saved-locations', ['citizen']],
  ['POST', '/api/citizen/saved-locations', ['citizen'], { label: 'Casa', address: 'Av. Siempreviva 742' }],
  ['PATCH', '/api/citizen/saved-locations/:id', ['citizen'], { label: 'Trabajo' }],
  ['DELETE', '/api/citizen/saved-locations/:id', ['citizen']],
];

// Rutas montadas que no exigen token (no entran en la matriz).
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /api-docs.json',
  // Contrato de eventos (asyncapi.yaml, #84): documentación pública, como Swagger.
  'GET /asyncapi',
  'GET /asyncapi.yaml',
  'POST /auth/dev/login',
]);

const CITIZEN_SUB = 'CIT-matriz';

// `groups` son los grupos internos con los que tiene que quedar la identidad:
// de ahí sale el resultado esperado. En los federados, `claims` es lo que trae
// el token del Login Federado (antes de IDP_GROUP_MAP).
const LOCAL_IDENTITIES = {
  'sin token': null,
  'token sin grupo': { sub: 'U-sin-grupo', groups: [] },
  citizen: { sub: CITIZEN_SUB, groups: ['citizen'] },
  dispatcher: { sub: 'DISP-matriz', groups: ['dispatcher'] },
  officer: { sub: 'of-001', groups: ['officer'] },
};

const HYBRID_SUB_ALIASES = { U000902: 'of-001' };

const HYBRID_IDENTITIES = {
  'sin token': null,
  'citizen local': { sub: CITIZEN_SUB, groups: ['citizen'] },
  'dispatcher local': { sub: 'DISP-matriz', groups: ['dispatcher'] },
  'federado con un grupo que el mapa no conoce': {
    federated: { sub: 'U000900', groups: ['guardia-finde'] },
    groups: [],
  },
  'federado DISPATCHERS (mayúsculas, aud string)': {
    federated: { sub: 'U000901', groups: ['DISPATCHERS'], aud: 'citypass-emergencias-api' },
    groups: ['dispatcher'],
  },
  'federado officer con alias a of-001': {
    federated: { sub: 'U000902', groups: ['officer'] },
    groups: ['officer'],
  },
  'federado delegado': {
    federated: { sub: 'U000903', groups: ['delegados'] },
    groups: ['delegado'],
  },
  'federado con citizen (no mapeado por default)': {
    federated: { sub: CITIZEN_SUB, groups: ['citizen'] },
    groups: [],
  },
};

function expectedOutcome(allowed, identity) {
  if (!identity) return 401;
  if (allowed === ANY_AUTHENTICATED) return 'permitido';
  return identity.groups.some((group) => allowed.includes(group)) ? 'permitido' : 403;
}

function casesFor(identities) {
  return ENDPOINTS.flatMap(([method, route, allowed, body]) => Object.entries(identities)
    .map(([name, identity]) => [method, route, name, expectedOutcome(allowed, identity), body]));
}

function createMockRepositories() {
  const emergency = {
    id: ID,
    userId: CITIZEN_SUB,
    status: 'PENDING',
    severity: 'critical',
    emergencyType: 'PANICO',
    assignedOfficerId: 'of-001',
    locationAnonymized: false,
  };

  return {
    emergencyRepository: {
      create: jest.fn(async (input) => ({ ...input, locationAnonymized: false })),
      findById: jest.fn(async () => ({ ...emergency })),
      findDetailById: jest.fn(async () => ({ ...emergency, statusHistory: [] })),
      findPage: jest.fn(async () => ({ emergencies: [], total: 0 })),
      findOutboxPage: jest.fn(async () => ({ events: [], total: 0 })),
      recordAccess: jest.fn(async () => ({})),
      updateStatus: jest.fn(async (id, { newStatus, actor, reason }) => ({
        emergency: { ...emergency, status: newStatus },
        history: { previousStatus: emergency.status, newStatus, actor, reason },
      })),
      assignOfficer: jest.fn(async () => ({
        emergency: { ...emergency, status: 'DISPATCHED' },
        officer: { id: 'of-001', name: 'Oficial Carlos Gómez' },
      })),
    },
    officerRepository: { findAll: jest.fn(async () => []) },
    incidentRepository: {
      findActivePage: jest.fn(async () => ({ incidents: [], total: 0 })),
      findByIdWithMembers: jest.fn(async () => ({ id: ID, members: [] })),
    },
    citizenProfileRepository: {
      getProfile: jest.fn(async () => null),
      upsertProfile: jest.fn(async (userId, data) => data),
      listSavedLocations: jest.fn(async () => []),
      addSavedLocation: jest.fn(async (userId, data) => ({ id: ID, ...data })),
      updateSavedLocation: jest.fn(async (userId, id, changes) => ({ id, ...changes })),
      removeSavedLocation: jest.fn(async () => true),
    },
  };
}

function allRepositoryMocks(repos) {
  return Object.values(repos).flatMap((repo) => Object.values(repo));
}

// Inventario de rutas montadas (Express 4: los routers se montan con una
// regexp tipo /^\/api\/emergencies\/?(?=\/|$)/i).
function mountedRoutes(app) {
  const routes = [];
  const add = (prefix, route) => {
    for (const method of Object.keys(route.methods)) {
      const path = route.path === '/' && prefix ? prefix : `${prefix}${route.path}`;
      routes.push(`${method.toUpperCase()} ${path}`);
    }
  };

  for (const layer of app._router.stack) {
    if (layer.route) {
      add('', layer.route);
    } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
      const prefix = layer.regexp.source
        .replace(/^\^/, '')
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/');
      for (const inner of layer.handle.stack) {
        if (inner.route) add(prefix, inner.route);
      }
    }
  }
  return routes;
}

// Mismos claims que un token local, pero firmado con otra clave RSA: el JWKS
// del middleware no la conoce.
async function foreignLocalBearer(tokenConfig) {
  const { privateKey: pem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keys = await createLocalKeySet(pem);
  const issuer = createLocalTokenIssuer(keys.privateKey, tokenConfig);
  const { access_token: token } = await issuer.issueAccessToken({ sub: 'DISP-matriz', groups: ['dispatcher'] });
  return `Bearer ${token}`;
}

const LOCAL_TOKEN_CONFIG = {
  issuer: 'https://idp.citypass.local',
  audience: 'citypass-emergencias-api',
  expectedTokenUse: 'human',
  expectedVer: 1,
  module: 'emergencias',
  tokenTtlSeconds: 900,
};

const asBearer = async (token) => `Bearer ${await token}`;
const FEDERATED_DISPATCHER = { sub: 'U000901', groups: ['dispatcher'] };

// Cada modo: cómo se arma la auth, qué identidades prueba y qué tokens tienen
// que dar 401 en todos los endpoints (funciones de la auth ya armada).
const MODES = [
  {
    title: 'AUTH_MODE=local',
    identities: LOCAL_IDENTITIES,
    createAuth: createLocalJwtAuth,
    invalidTokens: {
      'un JWT firmado por otra clave': () => foreignLocalBearer(LOCAL_TOKEN_CONFIG),
    },
  },
  {
    title: 'AUTH_MODE=hybrid',
    identities: HYBRID_IDENTITIES,
    async createAuth() {
      const hybrid = await createHybridJwtAuth({ IDP_SUB_ALIASES: JSON.stringify(HYBRID_SUB_ALIASES) });
      return {
        ...hybrid,
        otherIdp: await createFakeFederatedIdp(),
        bearerFor: (identity) => asBearer(identity.federated
          ? hybrid.federatedToken(identity.federated)
          : hybrid.localToken(identity)),
      };
    },
    invalidTokens: {
      'un JWT local firmado por otra clave': (auth) => foreignLocalBearer(auth.localConfig),
      'un JWT federado firmado por una clave fuera del JWKS': (auth) => asBearer(
        auth.otherIdp.sign(FEDERATED_DISPATCHER)
      ),
      'un JWT federado con iss desconocido': (auth) => asBearer(auth.federatedToken({
        ...FEDERATED_DISPATCHER, iss: 'https://otro-idp.example',
      })),
      'un JWT federado para otra audience': (auth) => asBearer(auth.federatedToken({
        ...FEDERATED_DISPATCHER, aud: ['citypass-reclamos-api'],
      })),
      'un token de servicio del Login Federado': (auth) => asBearer(auth.federatedToken({
        ...FEDERATED_DISPATCHER, token_use: 'service',
      })),
    },
  },
];

describe.each(MODES)('matriz de autorización con $title (JWT real, repositorios mockeados)', (mode) => {
  let app;
  let repos;
  const bearers = {};
  const invalidBearers = {};
  const invalidNames = Object.keys(mode.invalidTokens);

  beforeAll(async () => {
    const auth = await mode.createAuth();
    repos = createMockRepositories();
    app = createApp({ isEnabled: () => false, checkHealth: async () => false }, repos.emergencyRepository, {
      authenticate: auth.authenticate,
      devAuthRouter: auth.devAuthRouter,
      officerRepository: repos.officerRepository,
      incidentRepository: repos.incidentRepository,
      citizenProfileRepository: repos.citizenProfileRepository,
    });
    for (const [name, identity] of Object.entries(mode.identities)) {
      bearers[name] = identity ? await auth.bearerFor(identity) : null;
    }
    for (const [name, buildBearer] of Object.entries(mode.invalidTokens)) {
      invalidBearers[name] = await buildBearer(auth);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function send(method, route, bearer, body) {
    let req = request(app)[method.toLowerCase()](route.replace(':id', ID));
    if (bearer) req = req.set('Authorization', bearer);
    return body === undefined ? req : req.send(body);
  }

  it('la matriz cubre todas las rutas protegidas montadas en la app', () => {
    const protectedRoutes = mountedRoutes(app).filter((route) => !PUBLIC_ROUTES.has(route)).sort();
    const inMatrix = ENDPOINTS.map(([method, route]) => `${method} ${route}`).sort();

    expect(protectedRoutes).toEqual(inMatrix);
  });

  it.each(casesFor(mode.identities))('%s %s con %s → %s', async (method, route, identityName, expected, body) => {
    const res = await send(method, route, bearers[identityName], body);

    if (expected === 'permitido') {
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
      return;
    }

    expect(res.status).toBe(expected);
    expect(res.body.error).toBe(expected === 401 ? 'UnauthorizedError' : 'ForbiddenError');
    // La autorización corta antes de cualquier acceso a datos.
    for (const mock of allRepositoryMocks(repos)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  describe('tokens que no valen', () => {
    const cases = invalidNames.flatMap((tokenName) => ENDPOINTS
      .map(([method, route, , body]) => [method, route, tokenName, body]));

    it.each(cases)('%s %s con %s → 401', async (method, route, tokenName, body) => {
      const res = await send(method, route, invalidBearers[tokenName], body);
      expect(res.status).toBe(401);
      for (const mock of allRepositoryMocks(repos)) {
        expect(mock).not.toHaveBeenCalled();
      }
    });

    it('un esquema que no es Bearer → 401', async () => {
      const basicHeader = `Basic ${Buffer.from('DISP-matriz:x').toString('base64')}`;
      await send('GET', '/api/emergencies', basicHeader).expect(401);
    });
  });
});
