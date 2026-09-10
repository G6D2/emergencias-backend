const { startKeepWarmJob, isInsideWindow, parseWindows } = require('../jobs/keep-warm');

const ART = 'America/Argentina/Buenos_Aires';

describe('parseWindows', () => {
  it('parses DOW names and numbers into minutes', () => {
    expect(parseWindows('jue:17:00-23:30')).toEqual([{ dow: 4, start: 17 * 60, end: 23 * 60 + 30 }]);
    expect(parseWindows('4:17:00-23:30')).toEqual([{ dow: 4, start: 1020, end: 1410 }]);
    expect(parseWindows('0:00:00-24:00')).toEqual([{ dow: 0, start: 0, end: 1440 }]);
  });

  it('accepts several comma-separated windows, spaces, case and accents', () => {
    expect(parseWindows(' Jue:17:00-23:30 , mié:09:30-12:00,DOM:8:00-9:00 ')).toEqual([
      { dow: 4, start: 1020, end: 1410 },
      { dow: 3, start: 570, end: 720 },
      { dow: 0, start: 480, end: 540 },
    ]);
  });

  it('returns "always" (case-insensitive)', () => {
    expect(parseWindows('always')).toBe('always');
    expect(parseWindows(' ALWAYS ')).toBe('always');
  });

  it('rejects invalid formats', () => {
    for (const bad of ['', 'jue', 'jue:17:00', 'lunes:17:00-18:00', '7:10:00-11:00',
      'jue:25:00-26:00', 'jue:17:60-18:00', 'jue:17-18', 'jue:17:00-23:30,xx']) {
      expect(() => parseWindows(bad)).toThrow(/KEEP_WARM_WINDOWS/);
    }
  });
});

describe('isInsideWindow', () => {
  const windows = parseWindows('jue:17:00-23:30');

  it('jueves 20:30 UTC (17:30 ART) is inside', () => {
    expect(isInsideWindow(new Date('2026-09-10T20:30:00Z'), windows, ART)).toBe(true);
  });

  it('jueves 15:00 UTC (12:00 ART) is outside', () => {
    expect(isInsideWindow(new Date('2026-09-10T15:00:00Z'), windows, ART)).toBe(false);
  });

  it('viernes 02:00 UTC (jueves 23:00 ART) is inside', () => {
    expect(isInsideWindow(new Date('2026-09-11T02:00:00Z'), windows, ART)).toBe(true);
  });

  it('viernes 02:30 UTC (jueves 23:30 ART) is outside: end is exclusive', () => {
    expect(isInsideWindow(new Date('2026-09-11T02:30:00Z'), windows, ART)).toBe(false);
  });

  it('jueves 20:00 UTC (17:00 ART) is inside: start is inclusive', () => {
    expect(isInsideWindow(new Date('2026-09-10T20:00:00Z'), windows, ART)).toBe(true);
  });

  it('same instant on a different weekday is outside', () => {
    expect(isInsideWindow(new Date('2026-09-09T20:30:00Z'), windows, ART)).toBe(false);
  });

  it('honours the configured time zone', () => {
    // Jueves 17:00 UTC: dentro si la zona es UTC, fuera en ART (son las 14:00).
    expect(isInsideWindow(new Date('2026-09-10T17:00:00Z'), windows, 'UTC')).toBe(true);
    expect(isInsideWindow(new Date('2026-09-10T17:00:00Z'), windows, ART)).toBe(false);
  });

  it('accepts the raw string and "always"', () => {
    expect(isInsideWindow(new Date('2026-09-10T15:00:00Z'), 'jue:17:00-23:30', ART)).toBe(false);
    expect(isInsideWindow(new Date('2026-09-10T15:00:00Z'), 'always', ART)).toBe(true);
  });

  it('supports windows crossing midnight', () => {
    const late = parseWindows('jue:23:00-02:00');
    expect(isInsideWindow(new Date('2026-09-11T02:30:00Z'), late, ART)).toBe(true); // jue 23:30 ART
    expect(isInsideWindow(new Date('2026-09-11T04:30:00Z'), late, ART)).toBe(true); // vie 01:30 ART
    expect(isInsideWindow(new Date('2026-09-11T05:30:00Z'), late, ART)).toBe(false); // vie 02:30 ART
    expect(isInsideWindow(new Date('2026-09-10T20:30:00Z'), late, ART)).toBe(false); // jue 17:30 ART
  });
});

describe('startKeepWarmJob', () => {
  const INSIDE = new Date('2026-09-10T20:30:00Z');
  const OUTSIDE = new Date('2026-09-10T15:00:00Z');
  const baseEnv = {
    KEEP_WARM_URLS: 'https://backend.example/health, https://frontend.example/api/warmup',
    KEEP_WARM_INTERVAL_MS: '60000',
  };

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

  function okFetch() {
    return jest.fn(async () => ({ ok: true, status: 200 }));
  }

  it('pings every URL when inside the window', async () => {
    const fetchImpl = okFetch();
    const job = startKeepWarmJob({ env: baseEnv, fetchImpl, now: () => INSIDE });
    try {
      const result = await job.runOnce();
      expect(result.skipped).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
        'https://backend.example/health',
        'https://frontend.example/api/warmup',
      ]);
      const [, init] = fetchImpl.mock.calls[0];
      expect(init.method).toBe('GET');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      job.stop();
    }
  });

  it('does not ping outside the window', async () => {
    const fetchImpl = okFetch();
    const job = startKeepWarmJob({ env: baseEnv, fetchImpl, now: () => OUTSIDE });
    try {
      const result = await job.runOnce();
      expect(result.skipped).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      job.stop();
    }
  });

  it('pings anytime with KEEP_WARM_WINDOWS=always', async () => {
    const fetchImpl = okFetch();
    const job = startKeepWarmJob({
      env: { ...baseEnv, KEEP_WARM_WINDOWS: 'always' }, fetchImpl, now: () => OUTSIDE,
    });
    try {
      await job.runOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      job.stop();
    }
  });

  it('does nothing when disabled or without URLs', async () => {
    const fetchImpl = okFetch();
    const disabled = startKeepWarmJob({
      env: { ...baseEnv, KEEP_WARM_ENABLED: 'false' }, fetchImpl, now: () => INSIDE,
    });
    const noUrls = startKeepWarmJob({ env: {}, fetchImpl, now: () => INSIDE });
    await disabled.runOnce();
    await noUrls.runOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    disabled.stop();
    noUrls.stop();
  });

  it('disables itself (without throwing) on invalid windows or time zone', async () => {
    const fetchImpl = okFetch();
    const badWindows = startKeepWarmJob({
      env: { ...baseEnv, KEEP_WARM_WINDOWS: 'lunes:1-2' }, fetchImpl, now: () => INSIDE,
    });
    const badTz = startKeepWarmJob({
      env: { ...baseEnv, KEEP_WARM_TZ: 'Marte/Olympus' }, fetchImpl, now: () => INSIDE,
    });
    await badWindows.runOnce();
    await badTz.runOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    badWindows.stop();
    badTz.stop();
  });

  it('logs a warning on non-2xx and on failure, without bodies', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'SECRET_BODY' })
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const job = startKeepWarmJob({ env: baseEnv, fetchImpl, now: () => INSIDE });
    try {
      const result = await job.runOnce();
      expect(result.results.map((r) => r.ok)).toEqual([false, false]);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      const logged = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('503');
      expect(logged).toContain('ECONNRESET');
      expect(logged).not.toContain('SECRET_BODY');
    } finally {
      job.stop();
    }
  });

  it('keeps the interval running after a failed fetch', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ok: true, status: 200 });
    const job = startKeepWarmJob({
      env: { KEEP_WARM_URLS: 'https://backend.example/health', KEEP_WARM_INTERVAL_MS: '60000' },
      fetchImpl,
      now: () => INSIDE,
    });
    try {
      // Primera pasada diferida (30 s): falla.
      await jest.advanceTimersByTimeAsync(30_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Dos ticks del intervalo (60 s cada uno): sigue pegando.
      await jest.advanceTimersByTimeAsync(120_000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      job.stop();
    }
    await jest.advanceTimersByTimeAsync(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
