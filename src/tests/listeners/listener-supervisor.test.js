jest.mock('../../security/secure-log', () => ({ secureLog: jest.fn() }));

const { superviseListener, DEFAULT_RETRY_DELAYS_MS } = require('../../listeners/listener-supervisor');

class FakeListener {
  constructor(startResults) {
    // Cada llamada a start() consume el próximo resultado: true, false o un Error.
    this.startResults = [...startResults];
    this.start = jest.fn(async () => {
      const result = this.startResults.length > 1 ? this.startResults.shift() : this.startResults[0];
      if (result instanceof Error) throw result;
      this.running = result;
      return result;
    });
    this.stop = jest.fn(async () => {
      this.running = false;
    });
    this.running = false;
    this.onCrash = null;
  }

  status() {
    return { name: 'FakeListener', running: this.running, lastPollAt: null };
  }
}

// Deja correr las promesas pendientes (start() es async) con timers falsos.
const flush = () => new Promise((resolve) => jest.requireActual('timers').setImmediate(resolve));

describe('superviseListener', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('el backoff por default es 5 s, 30 s y 2 min', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000]);
  });

  it('si arranca de una, queda running', async () => {
    const listener = new FakeListener([true]);

    const handle = superviseListener(listener);
    await handle.ready;

    expect(listener.start).toHaveBeenCalledTimes(1);
    expect(handle.status()).toEqual({
      name: 'FakeListener', running: true, lastPollAt: null, status: 'running', nextRetryAt: null,
    });
  });

  it('sin topic (start devuelve false) queda disabled y no reintenta', async () => {
    const listener = new FakeListener([false]);

    const handle = superviseListener(listener);
    await handle.ready;
    jest.advanceTimersByTime(10 * 60_000);

    expect(listener.start).toHaveBeenCalledTimes(1);
    expect(handle.status().status).toBe('disabled');
  });

  it('si falla al arrancar, reintenta a los 5 s, 30 s y 2 min, y después cada 2 min (tope)', async () => {
    const listener = new FakeListener([new Error('no broker')]);
    const handle = superviseListener(listener);
    await handle.ready;

    expect(handle.status().status).toBe('retrying');
    expect(Date.parse(handle.status().nextRetryAt)).not.toBeNaN();

    for (const [delayMs, expectedCalls] of [[5_000, 2], [30_000, 3], [120_000, 4], [120_000, 5]]) {
      jest.advanceTimersByTime(delayMs - 1);
      await flush();
      expect(listener.start).toHaveBeenCalledTimes(expectedCalls - 1);
      jest.advanceTimersByTime(1);
      await flush();
      expect(listener.start).toHaveBeenCalledTimes(expectedCalls);
    }
    expect(handle.status().status).toBe('retrying');
  });

  it('cuando un reintento sale bien queda running y el backoff vuelve a empezar', async () => {
    const listener = new FakeListener([new Error('no broker'), true]);
    const handle = superviseListener(listener);
    await handle.ready;

    jest.advanceTimersByTime(5_000);
    await flush();

    expect(handle.status()).toMatchObject({ status: 'running', running: true, nextRetryAt: null });

    // Se cae después (CRASH sin restart): vuelve a esperar 5 s, no 30 s.
    listener.running = false;
    listener.onCrash(new Error('Topic authorization failed'));
    expect(handle.status().status).toBe('retrying');
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(listener.start).toHaveBeenCalledTimes(3);
    expect(handle.status().status).toBe('running');
  });

  it('stop() cancela el reintento pendiente y frena el listener', async () => {
    const listener = new FakeListener([new Error('no broker')]);
    const handle = superviseListener(listener);
    await handle.ready;

    await handle.stop();
    jest.advanceTimersByTime(10 * 60_000);
    await flush();

    expect(listener.start).toHaveBeenCalledTimes(1);
    expect(listener.stop).toHaveBeenCalledTimes(1);
    expect(handle.status()).toMatchObject({ status: 'stopped', nextRetryAt: null });
  });

  it('un CRASH después de stop() no programa reintentos', async () => {
    const listener = new FakeListener([true]);
    const handle = superviseListener(listener);
    await handle.ready;

    await handle.stop();
    listener.onCrash(new Error('tarde'));
    jest.advanceTimersByTime(10 * 60_000);

    expect(listener.start).toHaveBeenCalledTimes(1);
    expect(handle.status().status).toBe('stopped');
  });
});
