const { schedulePeriodicJob } = require('../utils/periodic-job');

describe('schedulePeriodicJob', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('corre una primera pasada diferida y después una por intervalo; stop corta las dos', async () => {
    jest.useFakeTimers();
    const runOnce = jest.fn().mockResolvedValue(null);
    const job = schedulePeriodicJob(runOnce, { intervalMs: 60_000 });

    expect(job.runOnce).toBe(runOnce);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(runOnce).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(45_000);
    expect(runOnce).toHaveBeenCalledTimes(2);

    job.stop();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('la primera pasada nunca espera más que el intervalo y acepta otra demora', async () => {
    jest.useFakeTimers();
    const fast = jest.fn().mockResolvedValue(null);
    const fastJob = schedulePeriodicJob(fast, { intervalMs: 5_000 });
    await jest.advanceTimersByTimeAsync(5_000);
    // A los 5 s coinciden la pasada diferida y la primera del intervalo.
    expect(fast).toHaveBeenCalledTimes(2);
    fastJob.stop();

    const slow = jest.fn().mockResolvedValue(null);
    const slowJob = schedulePeriodicJob(slow, { intervalMs: 60_000, firstRunDelayMs: 20_000 });
    await jest.advanceTimersByTimeAsync(19_999);
    expect(slow).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(slow).toHaveBeenCalledTimes(1);
    slowJob.stop();
  });

  it('los timers no retienen el proceso, y tolera timers sin unref', () => {
    const unref = jest.fn();
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockReturnValue({ unref });
    const intervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref });
    schedulePeriodicJob(jest.fn(), { intervalMs: 60_000 });
    expect(unref).toHaveBeenCalledTimes(2);

    timeoutSpy.mockReturnValue(1);
    intervalSpy.mockReturnValue(2);
    expect(() => schedulePeriodicJob(jest.fn(), { intervalMs: 60_000 })).not.toThrow();

    timeoutSpy.mockRestore();
    intervalSpy.mockRestore();
  });
});
