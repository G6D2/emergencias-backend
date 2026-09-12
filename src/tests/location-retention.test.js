const { startLocationRetentionJob } = require('../security/location-retention');

describe('startLocationRetentionJob', () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('no arranca timers si está deshabilitado', () => {
    const repo = { anonymizeExpiredLocations: jest.fn() };
    const job = startLocationRetentionJob(repo, { env: { LOCATION_RETENTION_ENABLED: 'false' } });

    expect(job.runOnce).toBeUndefined();
    job.stop();
    expect(logSpy).toHaveBeenCalledWith('Location retention job disabled');
  });

  it('rechaza LOCATION_RETENTION_HOURS inválido', () => {
    const repo = { anonymizeExpiredLocations: jest.fn() };
    expect(() => startLocationRetentionJob(repo, { env: { LOCATION_RETENTION_HOURS: '0' } }))
      .toThrow('LOCATION_RETENTION_HOURS must be a positive number');
    expect(() => startLocationRetentionJob(repo, { env: { LOCATION_RETENTION_HOURS: 'nope' } }))
      .toThrow('LOCATION_RETENTION_HOURS must be a positive number');
  });

  it('rechaza LOCATION_RETENTION_INTERVAL_MS inválido', () => {
    const repo = { anonymizeExpiredLocations: jest.fn() };
    expect(() => startLocationRetentionJob(repo, { env: { LOCATION_RETENTION_INTERVAL_MS: '500' } }))
      .toThrow('LOCATION_RETENTION_INTERVAL_MS must be >= 1000');
  });

  it('runOnce loguea cuando anonimiza filas', async () => {
    const repo = { anonymizeExpiredLocations: jest.fn().mockResolvedValue({ anonymizedCount: 3, ids: ['a', 'b', 'c'] }) };
    const job = startLocationRetentionJob(repo, { env: {} });

    const result = await job.runOnce();

    expect(result.anonymizedCount).toBe(3);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Location retention anonymized emergencies'));
    job.stop();
  });

  it('runOnce no loguea si no anonimizó nada', async () => {
    const repo = { anonymizeExpiredLocations: jest.fn().mockResolvedValue({ anonymizedCount: 0, ids: [] }) };
    const job = startLocationRetentionJob(repo, { env: {} });

    await job.runOnce();

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('anonymized'));
    job.stop();
  });

  it('runOnce captura errores del repository y devuelve null', async () => {
    const repo = { anonymizeExpiredLocations: jest.fn().mockRejectedValue(new Error('db down')) };
    const job = startLocationRetentionJob(repo, { env: {} });

    const result = await job.runOnce();

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Location retention job failed'));
    job.stop();
  });

  it('arranca timers, corre la primera pasada diferida y respeta el intervalo; stop los detiene', async () => {
    jest.useFakeTimers();
    const repo = { anonymizeExpiredLocations: jest.fn().mockResolvedValue({ anonymizedCount: 0, ids: [] }) };
    const job = startLocationRetentionJob(repo, {
      env: { LOCATION_RETENTION_INTERVAL_MS: '60000' },
    });

    await jest.advanceTimersByTimeAsync(15_000);
    expect(repo.anonymizeExpiredLocations).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(repo.anonymizeExpiredLocations).toHaveBeenCalledTimes(2);

    job.stop();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(repo.anonymizeExpiredLocations).toHaveBeenCalledTimes(2);
  });
});
