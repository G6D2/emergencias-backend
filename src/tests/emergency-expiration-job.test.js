const { startEmergencyExpirationJob, ACTOR } = require('../services/emergency-expiration-job');

describe('startEmergencyExpirationJob', () => {
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

  const repoWith = (result = { expiredCount: 0, failedCount: 0, expired: [] }) => ({
    expireStaleEmergencies: jest.fn().mockResolvedValue(result),
  });

  it('no arranca timers si está deshabilitado', () => {
    const repo = repoWith();
    const job = startEmergencyExpirationJob(repo, { env: { EMERGENCY_EXPIRATION_ENABLED: 'false' } });

    expect(job.runOnce).toBeUndefined();
    job.stop();
    expect(logSpy).toHaveBeenCalledWith('Emergency expiration job disabled');
    expect(repo.expireStaleEmergencies).not.toHaveBeenCalled();
  });

  it('rechaza un plazo o un intervalo inválidos', () => {
    const repo = repoWith();
    expect(() => startEmergencyExpirationJob(repo, { env: { EMERGENCY_EXPIRATION_HOURS: '0' } }))
      .toThrow('EMERGENCY_EXPIRATION_HOURS must be a positive number');
    expect(() => startEmergencyExpirationJob(repo, { env: { EMERGENCY_EXPIRATION_HOURS: 'nope' } }))
      .toThrow('EMERGENCY_EXPIRATION_HOURS must be a positive number');
    expect(() => startEmergencyExpirationJob(repo, { env: { EMERGENCY_EXPIRATION_INTERVAL_MS: '500' } }))
      .toThrow('EMERGENCY_EXPIRATION_INTERVAL_MS must be >= 1000');
  });

  it('por defecto usa el plazo de retención de ubicaciones (72 h)', async () => {
    const repo = repoWith();
    const job = startEmergencyExpirationJob(repo, { env: {} });
    await job.runOnce();
    job.stop();

    expect(repo.expireStaleEmergencies).toHaveBeenCalledWith(72, expect.objectContaining({
      actor: 'sistema:expiracion',
      reason: 'Expirada: sin cambios de estado en 72 h',
    }));
  });

  it('sigue a LOCATION_RETENTION_HOURS, y EMERGENCY_EXPIRATION_HOURS le gana', async () => {
    const repoA = repoWith();
    const jobA = startEmergencyExpirationJob(repoA, { env: { LOCATION_RETENTION_HOURS: '48' } });
    await jobA.runOnce();
    jobA.stop();
    expect(repoA.expireStaleEmergencies.mock.calls[0][0]).toBe(48);

    const repoB = repoWith();
    const jobB = startEmergencyExpirationJob(repoB, {
      env: { LOCATION_RETENTION_HOURS: '48', EMERGENCY_EXPIRATION_HOURS: '12' },
    });
    await jobB.runOnce();
    jobB.stop();
    expect(repoB.expireStaleEmergencies.mock.calls[0][0]).toBe(12);
    expect(repoB.expireStaleEmergencies.mock.calls[0][1].reason).toBe('Expirada: sin cambios de estado en 12 h');
  });

  it('el evento del outbox es un EmergenciaActualizada con el actor del sistema y el motivo', async () => {
    const repo = repoWith();
    const job = startEmergencyExpirationJob(repo, { env: { TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO: 'test.actualizada' } });
    await job.runOnce();
    job.stop();

    const { outboxEvent } = repo.expireStaleEmergencies.mock.calls[0][1];
    expect(outboxEvent.topic).toBe('test.actualizada');
    const event = outboxEvent.payload(
      {
        emergency: {
          id: 'em-1', severity: 'high', barrio: 'PALERMO', latitude: null, longitude: null,
          updatedAt: '2026-11-12T12:00:00.000Z',
        },
        history: { previousStatus: 'DISPATCHED', newStatus: 'CANCELLED' },
      },
      'evt-1'
    );
    expect(event.type).toBe('EmergenciaActualizada');
    expect(event.data).toMatchObject({
      emergenciaId: 'em-1',
      estadoAnterior: 'DESPACHADA',
      estadoNuevo: 'CANCELADA',
      usuarioId: ACTOR,
      resolucion: 'Expirada: sin cambios de estado en 72 h',
      barrio: 'PALERMO',
      latitud: null,
      longitud: null,
    });
  });

  it('sin la variable del tópico usa el default', async () => {
    const repo = repoWith();
    const job = startEmergencyExpirationJob(repo, { env: {} });
    await job.runOnce();
    job.stop();
    expect(repo.expireStaleEmergencies.mock.calls[0][1].outboxEvent.topic).toBe('emergencias.estado-actualizado');
  });

  it('runOnce loguea cuando expiró algo o hubo fallas, y no loguea si no pasó nada', async () => {
    const quiet = startEmergencyExpirationJob(repoWith(), { env: {} });
    await quiet.runOnce();
    quiet.stop();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Emergency expiration closed'));

    const busy = startEmergencyExpirationJob(repoWith({ expiredCount: 2, failedCount: 1, expired: [] }), { env: {} });
    const result = await busy.runOnce();
    busy.stop();
    expect(result.expiredCount).toBe(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Emergency expiration closed stale emergencies'));
  });

  it('runOnce captura errores del repository y devuelve null', async () => {
    const repo = { expireStaleEmergencies: jest.fn().mockRejectedValue(new Error('db down')) };
    const job = startEmergencyExpirationJob(repo, { env: {} });

    await expect(job.runOnce()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Emergency expiration job failed'));
    job.stop();
  });

  it('arranca timers, corre la primera pasada diferida y respeta el intervalo; stop los detiene', async () => {
    jest.useFakeTimers();
    const repo = repoWith();
    const job = startEmergencyExpirationJob(repo, { env: { EMERGENCY_EXPIRATION_INTERVAL_MS: '60000' } });

    await jest.advanceTimersByTimeAsync(15_000);
    expect(repo.expireStaleEmergencies).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(repo.expireStaleEmergencies).toHaveBeenCalledTimes(2);

    job.stop();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(repo.expireStaleEmergencies).toHaveBeenCalledTimes(2);
  });
});
