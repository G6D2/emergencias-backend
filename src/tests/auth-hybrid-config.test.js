const { loadAuthConfig, localTokenConfig } = require('../auth/config');
const { createAuthSetup } = require('../auth/setup');
const {
  DEFAULT_IDP_GROUP_MAP,
  parseGroupMap,
  parseSubAliases,
  mapFederatedGroups,
  applySubAlias,
} = require('../auth/federated-claims');
const { HYBRID_AUTH_ENV } = require('./helpers/hybrid-jwt');

function hybrid(overrides = {}) {
  return loadAuthConfig({ ...HYBRID_AUTH_ENV, ...overrides });
}

describe('loadAuthConfig con AUTH_MODE=hybrid', () => {
  it('arma la config federada y la local por separado', () => {
    const config = hybrid();

    expect(config.mode).toBe('hybrid');
    expect(config.federated).toMatchObject({
      issuer: 'https://idp.citypass.local',
      audience: 'citypass-emergencias-api',
      jwksUri: 'https://api.citypass-login.pp.ua/.well-known/jwks.json',
      clockTolerance: 60,
      tokenUse: 'human',
      tokenVer: 1,
      requireTokenUse: false,
      requireTokenVer: false,
      subjectClaim: 'sub',
      groupsClaim: 'groups',
    });
    expect(config.federated.subAliases.size).toBe(0);
    expect(config.local).toEqual({
      issuer: 'urn:citypass:emergencias:local',
      audience: 'citypass-emergencias-api',
    });
  });

  it('los tokens locales usan LOCAL_JWT_ISSUER / LOCAL_JWT_AUDIENCE', () => {
    const config = hybrid({ LOCAL_JWT_ISSUER: 'urn:emergencias:demo', LOCAL_JWT_AUDIENCE: 'emergencias-local' });

    expect(localTokenConfig(config)).toMatchObject({
      issuer: 'urn:emergencias:demo',
      audience: 'emergencias-local',
      expectedTokenUse: 'human',
      expectedVer: 1,
      tokenTtlSeconds: 900,
    });
  });

  it('en local, la config de los tokens locales es la de siempre', () => {
    const config = loadAuthConfig({ AUTH_MODE: 'local', NODE_ENV: 'test', LOCAL_JWT_ISSUER: 'urn:ignorado' });
    expect(localTokenConfig(config)).toBe(config);
    expect(config.issuer).toBe('https://idp.citypass.local');
    expect(config).not.toHaveProperty('federated');
  });

  it('idp no cambia: sin config federada ni local', () => {
    const config = loadAuthConfig({ ...HYBRID_AUTH_ENV, AUTH_MODE: 'idp' });
    expect(config.mode).toBe('idp');
    expect(config).not.toHaveProperty('federated');
    expect(config).not.toHaveProperty('local');
  });

  it.each(['IDP_ISSUER', 'IDP_AUDIENCE', 'IDP_JWKS_URI'])('exige %s', (name) => {
    expect(() => hybrid({ [name]: undefined })).toThrow(
      'AUTH_MODE=hybrid requires IDP_ISSUER, IDP_AUDIENCE and IDP_JWKS_URI'
    );
  });

  it('createAuthSetup arma hybrid con el JWKS remoto real (jose lo baja con el primer token federado)', async () => {
    const auth = await createAuthSetup({ env: HYBRID_AUTH_ENV });

    expect(auth.mode).toBe('hybrid');
    expect(typeof auth.authenticate).toBe('function');
    expect(auth.devAuthRouter).not.toBeNull();
  });

  it('el mensaje de modo inválido nombra los tres modos', () => {
    expect(() => loadAuthConfig({ AUTH_MODE: 'mixto' })).toThrow('use "local", "idp" or "hybrid"');
  });

  describe('NODE_ENV=production', () => {
    it('hybrid arranca sin ALLOW_LOCAL_AUTH: elegir hybrid ya declara los tokens locales', () => {
      const config = hybrid({ NODE_ENV: 'production' });
      expect(config.mode).toBe('hybrid');
    });

    it('hybrid ignora ALLOW_LOCAL_AUTH (da igual true o false)', () => {
      expect(hybrid({ NODE_ENV: 'production', ALLOW_LOCAL_AUTH: 'false' }).local).toEqual(
        hybrid({ NODE_ENV: 'production', ALLOW_LOCAL_AUTH: 'true' }).local
      );
    });

    it('local sigue exigiendo ALLOW_LOCAL_AUTH=true', () => {
      expect(() => loadAuthConfig({ AUTH_MODE: 'local', NODE_ENV: 'production' })).toThrow(/not allowed/);
      expect(loadAuthConfig({ AUTH_MODE: 'local', NODE_ENV: 'production', ALLOW_LOCAL_AUTH: 'true' }).mode)
        .toBe('local');
    });
  });

  it('rechaza un issuer local igual al federado', () => {
    expect(() => hybrid({ LOCAL_JWT_ISSUER: 'https://idp.citypass.local' })).toThrow(
      /LOCAL_JWT_ISSUER different from IDP_ISSUER/
    );
  });

  it.each([
    ['no es una URL', 'jwks.json'],
    ['es http fuera de localhost', 'http://api.citypass-login.pp.ua/.well-known/jwks.json'],
    ['es otro protocolo', 'ftp://api.citypass-login.pp.ua/jwks.json'],
  ])('rechaza IDP_JWKS_URI que %s', (label, uri) => {
    expect(() => hybrid({ IDP_JWKS_URI: uri })).toThrow(/IDP_JWKS_URI/);
  });

  it('acepta http solo contra localhost', () => {
    expect(hybrid({ IDP_JWKS_URI: 'http://localhost:9000/jwks.json' }).federated.jwksUri)
      .toBe('http://localhost:9000/jwks.json');
  });

  it.each(['IDP_REQUIRE_TOKEN_USE', 'IDP_REQUIRE_TOKEN_VER'])('%s solo acepta true o false', (name) => {
    expect(hybrid({ [name]: 'true' }).federated).toBeDefined();
    expect(() => hybrid({ [name]: 'si' })).toThrow(`${name} must be "true" or "false"`);
  });

  it.each(['IDP_SUBJECT_CLAIM', 'IDP_GROUPS_CLAIM'])('%s tiene que ser un nombre de claim simple', (name) => {
    expect(() => hybrid({ [name]: 'realm_access.roles' })).toThrow(name);
    expect(() => hybrid({ [name]: '__proto__ x' })).toThrow(name);
  });

  it('rechaza IDP_GROUP_MAP inválido al arrancar', () => {
    expect(() => hybrid({ IDP_GROUP_MAP: '{roto' })).toThrow('IDP_GROUP_MAP must be valid JSON');
    expect(() => hybrid({ IDP_GROUP_MAP: '["dispatcher"]' })).toThrow('IDP_GROUP_MAP must be a JSON object');
    expect(() => hybrid({ IDP_GROUP_MAP: '{"jefes":"admin"}' })).toThrow(/IDP_GROUP_MAP\["jefes"\]/);
    expect(() => hybrid({ IDP_GROUP_MAP: '{"  ":"dispatcher"}' })).toThrow(/empty group name/);
  });

  it('rechaza IDP_SUB_ALIASES inválido al arrancar', () => {
    expect(() => hybrid({ IDP_SUB_ALIASES: 'of-001' })).toThrow('IDP_SUB_ALIASES must be valid JSON');
    expect(() => hybrid({ IDP_SUB_ALIASES: 'null' })).toThrow('IDP_SUB_ALIASES must be a JSON object');
    expect(() => hybrid({ IDP_SUB_ALIASES: '{"U000777":1}' })).toThrow(/non-empty internal ids/);
    expect(() => hybrid({ IDP_SUB_ALIASES: '{"":"of-001"}' })).toThrow(/non-empty internal ids/);
    expect(() => hybrid({ IDP_SUB_ALIASES: '{"U000777":"  "}' })).toThrow(/non-empty internal ids/);
  });
});

describe('federated-claims', () => {
  it('el mapa por default refleja lo que reconoce el front, sin citizen', () => {
    const map = parseGroupMap(undefined);
    expect([...map.keys()].sort()).toEqual(Object.keys(DEFAULT_IDP_GROUP_MAP).sort());
    expect(map.get('operador')).toEqual(['dispatcher']);
    expect(map.get('delegados')).toEqual(['delegado']);
    expect(map.has('citizen')).toBe(false);
  });

  it('IDP_GROUP_MAP normaliza claves, junta repetidas y admite [] para "no habilita nada"', () => {
    const map = parseGroupMap(JSON.stringify({
      ' Operadores ': 'dispatcher',
      operadores: ['officer', 'dispatcher'],
      consulta: [],
    }));
    expect(map.get('operadores')).toEqual(['dispatcher', 'officer']);
    expect(map.get('consulta')).toEqual([]);
  });

  it('una clave __proto__ no contamina nada (Map, no objeto)', () => {
    const map = parseGroupMap('{"__proto__":"dispatcher"}');
    expect(map.get('__proto__')).toEqual(['dispatcher']);
    expect({}.dispatcher).toBeUndefined();
  });

  it('mapFederatedGroups ignora mayúsculas, desconocidos y repetidos', () => {
    const map = parseGroupMap(undefined);
    expect(mapFederatedGroups(['Dispatcher', 'operador', 'otro', 'OFFICER'], map).sort())
      .toEqual(['dispatcher', 'officer']);
    expect(mapFederatedGroups([], map)).toEqual([]);
  });

  it('parseSubAliases devuelve un Map vacío sin variable', () => {
    expect(parseSubAliases(undefined).size).toBe(0);
    expect(parseSubAliases('  ').size).toBe(0);
    expect(parseSubAliases('{"U000777":" of-001 "}').get('U000777')).toBe('of-001');
  });

  describe('applySubAlias', () => {
    const aliases = parseSubAliases('{"U000777":"of-001"}');

    it('traduce el sub de un federado y conserva el original en idpSub', () => {
      const user = { sub: 'U000777', idpSub: 'U000777', authSource: 'federated', groups: ['officer'] };
      expect(applySubAlias(user, aliases)).toEqual({ ...user, sub: 'of-001' });
    });

    it('no toca tokens locales, federados sin alias ni identidades vacías', () => {
      const local = { sub: 'U000777', authSource: 'local' };
      const otro = { sub: 'U1', idpSub: 'U1', authSource: 'federated' };
      expect(applySubAlias(local, aliases)).toBe(local);
      expect(applySubAlias(otro, aliases)).toBe(otro);
      expect(applySubAlias(otro, null)).toBe(otro);
      expect(applySubAlias(null, aliases)).toBeNull();
    });
  });
});
