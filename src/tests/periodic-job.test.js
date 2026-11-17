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

  it('no solapa corridas: si la anterior no terminó, el tick se saltea y el siguiente corre', async () => {
    jest.useFakeTimers();
    const finish = [];
    const runOnce = jest.fn(() => new Promise((resolve) => {
      finish.push(resolve);
    }));
    const job = schedulePeriodicJob(runOnce, { intervalMs: 10_000, firstRunDelayMs: 1_000 });

    // Primera pasada (1 s): arranca y queda en curso.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    // Ticks de los 10 s y los 20 s: la primera sigue corriendo, se saltean.
    await jest.advanceTimersByTimeAsync(19_000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    // Termina la primera: el tick de los 30 s vuelve a correr.
    finish[0]();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runOnce).toHaveBeenCalledTimes(2);

    // Y mientras esa segunda no termine, el de los 40 s se saltea de nuevo.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runOnce).toHaveBeenCalledTimes(2);

    finish[1]();
    job.stop();
  });

  it('una corrida que termina a tiempo no frena a la siguiente', async () => {
    jest.useFakeTimers();
    const runOnce = jest.fn().mockResolvedValue(null);
    const job = schedulePeriodicJob(runOnce, { intervalMs: 10_000, firstRunDelayMs: 1_000 });

    await jest.advanceTimersByTimeAsync(30_000);
    // 1 s (primera pasada) + 10 s, 20 s y 30 s.
    expect(runOnce).toHaveBeenCalledTimes(4);
    job.stop();
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
