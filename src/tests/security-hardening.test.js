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

  it('verifies certificates by default', () => {
    expect(resolveSslConfig({})).toEqual({ rejectUnauthorized: true });
  });

  it('allows insecure opt-in', () => {
    expect(resolveSslConfig({ DATABASE_SSL_INSECURE: 'true' })).toEqual({
      rejectUnauthorized: false,
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
      { sub: 'DISP-Demo001', groups: ['citizen'] },
      { NODE_ENV: 'production' }
    );
    expect(demo.groups).toEqual(['dispatcher']);
  });
});

describe('buildEmergencyCreatedEvent', () => {
  it('omits free-text description from the bus payload', () => {
    const event = buildEmergencyCreatedEvent({
      id: 'e1',
      userId: 'u1',
      description: 'llamar a juan@mail.com',
      severity: 'critical',
      status: 'PENDING',
      emergencyType: 'PANICO',
    }, 'evt-1');

    expect(event.data.description).toBeUndefined();
    expect(event.data.hasDescription).toBe(true);
    expect(event.data.userId).toBe('u1');
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
