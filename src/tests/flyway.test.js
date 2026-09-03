jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('fs', () => ({ writeFileSync: jest.fn(), unlinkSync: jest.fn() }));
jest.mock('os', () => ({ tmpdir: () => '/tmp' }));

const { spawnSync } = require('child_process');
const fs = require('fs');
const { runFlyway } = require('../../scripts/lib/flyway');

describe('runFlyway optional env propagation', () => {
  const baseConnectionInfo = {
    host: 'db.example.com',
    port: '5432',
    database: 'emergencias',
    user: 'user',
    password: 'pass',
  };
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    spawnSync.mockReturnValue({ status: 0 });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('includes baseline env vars when defined', () => {
    process.env.FLYWAY_BASELINE_ON_MIGRATE = 'true';
    process.env.FLYWAY_BASELINE_VERSION = '5';

    runFlyway(baseConnectionInfo, {
      command: 'migrate',
      migrationsDir: '/work/db/migrations',
      sslmode: 'require',
    });

    const [, envFileContents] = fs.writeFileSync.mock.calls[0];
    expect(envFileContents).toContain('FLYWAY_BASELINE_ON_MIGRATE=true');
    expect(envFileContents).toContain('FLYWAY_BASELINE_VERSION=5');
  });

  it('does not include baseline env vars when undefined', () => {
    delete process.env.FLYWAY_BASELINE_ON_MIGRATE;
    delete process.env.FLYWAY_BASELINE_VERSION;

    runFlyway(baseConnectionInfo, {
      command: 'migrate',
      migrationsDir: '/work/db/migrations',
      sslmode: 'require',
    });

    const [, envFileContents] = fs.writeFileSync.mock.calls[0];
    expect(envFileContents).not.toContain('FLYWAY_BASELINE_ON_MIGRATE');
    expect(envFileContents).not.toContain('FLYWAY_BASELINE_VERSION');
  });
});
