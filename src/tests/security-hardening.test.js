const {
  scrubFreeText,
  MAX_DESCRIPTION_LENGTH,
} = require('../security/pii-scrub');
const { resolveSslConfig } = require('../db/pool');
const { resolveDevLoginClaims, isDevLoginStrict } = require('../auth/dev-login-policy');
const { buildEmergencyCreatedEvent } = require('../services/emergency-events');
const { startCitizenProfileRetentionJob } = require('../security/citizen-profile-retention');

describe('scrubFreeText', () => {
  it('redacts email, phone-like and CUIL patterns', () => {
    const out = scrubFreeText(
      'Avisar a juan@mail.com o al 11-4567-8901 CUIL 20-12345678-9'
    );
    expect(out).toContain('[email]');
    expect(out).toContain('[tel]');
    expect(out).toContain('[id]');
    expect(out).not.toContain('juan@mail.com');
    expect(out).not.toContain('20-12345678-9');
  });

  it('truncates to max length', () => {
    const out = scrubFreeText('x'.repeat(500));
    expect(out).toHaveLength(MAX_DESCRIPTION_LENGTH);
  });

  it('uses fallback when empty', () => {
    expect(scrubFreeText('   ', { fallback: 'default' })).toBe('default');
  });
});

describe('resolveSslConfig', () => {
  it('disables SSL when DATABASE_SSL=false', () => {
    expect(resolveSslConfig({ DATABASE_SSL: 'false' })).toBe(false);
  });

  it('uses relaxed cert check by default (Neon pooler safe)', () => {
    expect(resolveSslConfig({})).toEqual({ rejectUnauthorized: false });
  });

  it('verifies certificates when DATABASE_SSL_VERIFY=true', () => {
    expect(resolveSslConfig({ DATABASE_SSL_VERIFY: 'true' })).toEqual({
      rejectUnauthorized: true,
    });
  });
});

describe('resolveDevLoginClaims', () => {
  it('allows freeform sub in non-strict mode with filtered groups', () => {
    const claims = resolveDevLoginClaims(
      { sub: 'U000099', groups: ['citizen', 'admin', 'dispatcher'] },
      { NODE_ENV: 'test' }
    );
    expect(claims.sub).toBe('U000099');
    expect(claims.groups).toEqual(['citizen', 'dispatcher']);
  });

  it('restricts to allowlist in production', () => {
    expect(isDevLoginStrict({ NODE_ENV: 'production' })).toBe(true);
    expect(() => resolveDevLoginClaims(
      { sub: 'hacker', groups: ['dispatcher'] },
      { NODE_ENV: 'production' }
    )).toThrow(/Demo subject not allowed/);

    const demo = resolveDevLoginClaims(
      { sub: 'CIT-JuanPanico', groups: ['dispatcher'] },
      { NODE_ENV: 'production' }
    );
    expect(demo.groups).toEqual(['citizen']);
    expect(demo.has_antipanic_button).toBe(true);
  });

  it('never issues a dispatcher token in strict mode, not even for the old demo sub', () => {
    expect(() => resolveDevLoginClaims(
      { sub: 'DISP-Demo001', groups: ['dispatcher'] },
      { DEV_LOGIN_STRICT: 'true' }
    )).toThrow(/Demo subject not allowed/);
  });
});

describe('buildEmergencyCreatedEvent', () => {
  it('omits free-text description and address from the bus payload', () => {
    // Contrato cerrado 2026-11-02 (issue #48): descripcion, titulo y direccion
    // NO viajan al bus aunque Analitica tenga columnas (su codigo los deja null).
    const event = buildEmergencyCreatedEvent({
      id: 'e1',
      userId: 'u1',
      description: 'llamar a juan@mail.com',
      address: 'Av. Corrientes 1234',
      severity: 'critical',
      status: 'PENDING',
      emergencyType: 'PANICO',
    }, 'evt-1');

    expect(event.data.description).toBeUndefined();
    expect(event.data.address).toBeUndefined();
    expect(event.data.ciudadanoId).toBe('u1');
    expect(event.data.categoria).toBe('PANICO');
    expect(event.data.prioridad).toBe('CRITICA');
    expect(event.data.estado).toBe('PENDIENTE');
  });
});

describe('startCitizenProfileRetentionJob', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('is disabled when CITIZEN_PII_RETENTION_ENABLED=false', () => {
    const job = startCitizenProfileRetentionJob(
      { anonymizeStaleProfiles: jest.fn() },
      { env: { CITIZEN_PII_RETENTION_ENABLED: 'false' } }
    );
    expect(job.runOnce).toBeUndefined();
    job.stop();
  });

  it('runOnce anonymizes profiles and deletes stale locations', async () => {
    const repo = {
      anonymizeStaleProfiles: jest.fn().mockResolvedValue({ anonymizedCount: 2, userIds: ['a', 'b'] }),
      deleteStaleSavedLocations: jest.fn().mockResolvedValue({ deletedCount: 1, ids: ['l1'] }),
    };
    const job = startCitizenProfileRetentionJob(repo, {
      env: { CITIZEN_PII_RETENTION_DAYS: '90', CITIZEN_PII_RETENTION_INTERVAL_MS: '60000' },
    });

    const result = await job.runOnce();
    expect(result.profiles.anonymizedCount).toBe(2);
    expect(result.locations.deletedCount).toBe(1);
    job.stop();
  });
});
