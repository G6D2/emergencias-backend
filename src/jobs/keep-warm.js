const { secureLog } = require('../security/secure-log');

/**
 * Keep-warm in-process.
 *
 * Render (plan free) duerme el servicio tras 15 minutos sin tráfico y tarda
 * 50-60 s en despertar. El workflow `.github/workflows/keep-warm.yml` lo
 * despierta con un cron, pero los crons de GitHub Actions son "best effort":
 * pueden demorarse o saltearse (el jueves 10/09 no corrió ninguna ejecución
 * programada). Por eso el cron queda solo como PRIMER despertar, y una vez
 * arriba el backend se mantiene solo: cada KEEP_WARM_INTERVAL_MS hace GET a
 * cada URL de KEEP_WARM_URLS (su propia URL pública -que pasa por el edge de
 * Render y cuenta como tráfico- y el /api/warmup del frontend), únicamente
 * dentro de las ventanas horarias de KEEP_WARM_WINDOWS (default: jueves en
 * horario de clase, hora Argentina), para no gastar las 750 h/mes gratis.
 *
 * Variables:
 *   KEEP_WARM_ENABLED      'false' desactiva el job (default: activo)
 *   KEEP_WARM_URLS         URLs separadas por coma (default vacío = no hace nada)
 *   KEEP_WARM_WINDOWS      'DOW:HH:MM-HH:MM' separadas por coma, o 'always'
 *                          DOW: 0=dom … 6=sab, o lun,mar,mie,jue,vie,sab,dom
 *                          (default: jue:17:00-23:30)
 *   KEEP_WARM_TZ           zona IANA para evaluar ventanas
 *                          (default: America/Argentina/Buenos_Aires)
 *   KEEP_WARM_INTERVAL_MS  intervalo entre pasadas (default: 8 min)
 */

const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
const DEFAULT_WINDOWS = 'jue:17:00-23:30';
const DEFAULT_INTERVAL_MS = 8 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

const DOW_BY_NAME = { dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6 };
const DOW_BY_INTL = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function normalizeDow(raw) {
  const value = String(raw).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/^[0-6]$/.test(value)) return Number(value);
  if (value in DOW_BY_NAME) return DOW_BY_NAME[value];
  return null;
}

function parseTime(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
  return hours * 60 + minutes;
}

/**
 * Parsea `KEEP_WARM_WINDOWS`. Devuelve `'always'` o un array de
 * `{ dow, start, end }` (start/end en minutos desde las 00:00 de la zona).
 * Una ventana con `end <= start` (ej. `vie:23:00-02:00`) cruza la medianoche.
 * Lanza Error si el formato es inválido.
 */
function parseWindows(str) {
  const input = String(str ?? '').trim();
  if (input.toLowerCase() === 'always') return 'always';
  if (input === '') {
    throw new Error('KEEP_WARM_WINDOWS must not be empty (use "always" or DOW:HH:MM-HH:MM)');
  }

  return input.split(',').map((chunk) => {
    const spec = chunk.trim();
    const match = /^([^:]+):([^-]+)-(.+)$/.exec(spec);
    const dow = match ? normalizeDow(match[1]) : null;
    const start = match ? parseTime(match[2]) : null;
    const end = match ? parseTime(match[3]) : null;
    if (dow == null || start == null || end == null) {
      throw new Error(`Invalid KEEP_WARM_WINDOWS entry "${spec}" (expected DOW:HH:MM-HH:MM)`);
    }
    return { dow, start, end };
  });
}

/** Día de semana (0=dom) y minutos desde las 00:00 de `date` en la zona `tz`. */
function localDayAndMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const dow = DOW_BY_INTL[get('weekday')];
  const minutes = Number(get('hour')) % 24 * 60 + Number(get('minute'));
  return { dow, minutes };
}

/**
 * `true` si `date` cae dentro de alguna ventana. `windows` puede ser el string
 * crudo o el resultado de `parseWindows`.
 */
function isInsideWindow(date, windows, tz = DEFAULT_TZ) {
  const parsed = typeof windows === 'string' ? parseWindows(windows) : windows;
  if (parsed === 'always') return true;

  const { dow, minutes } = localDayAndMinutes(date, tz);
  return parsed.some(({ dow: winDow, start, end }) => {
    if (end > start) {
      return dow === winDow && minutes >= start && minutes < end;
    }
    // Cruza la medianoche: [start, 24:00) del día + [00:00, end) del siguiente.
    const nextDow = (winDow + 1) % 7;
    return (dow === winDow && minutes >= start && minutes < MINUTES_PER_DAY)
      || (dow === nextDow && minutes < end);
  });
}

function parseUrls(raw) {
  return String(raw ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

/**
 * Arranca el job. Opciones (para tests): `env`, `fetchImpl`, `now`.
 * Devuelve `{ stop, runOnce }`.
 */
function startKeepWarmJob(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => new Date());
  const noop = { stop() {}, runOnce: async () => ({ skipped: true }) };

  if (env.KEEP_WARM_ENABLED === 'false') {
    secureLog('info', 'Keep-warm job disabled');
    return noop;
  }

  const urls = parseUrls(env.KEEP_WARM_URLS);
  if (urls.length === 0) {
    secureLog('info', 'Keep-warm job idle: KEEP_WARM_URLS is empty');
    return noop;
  }

  if (typeof fetchImpl !== 'function') {
    secureLog('warn', 'Keep-warm job disabled: fetch is not available');
    return noop;
  }

  const tz = env.KEEP_WARM_TZ || DEFAULT_TZ;
  const intervalMs = Number(env.KEEP_WARM_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  let windows;
  try {
    windows = parseWindows(env.KEEP_WARM_WINDOWS ?? DEFAULT_WINDOWS);
    // Falla temprano si la zona no existe.
    localDayAndMinutes(now(), tz);
  } catch (error) {
    // Un keep-warm mal configurado no debe tirar abajo el servicio.
    secureLog('warn', 'Keep-warm job disabled: invalid configuration', { message: error.message });
    return noop;
  }

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    secureLog('warn', 'Keep-warm job disabled: KEEP_WARM_INTERVAL_MS must be >= 1000');
    return noop;
  }

  async function ping(url) {
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': 'emergencias-backend/keep-warm' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const meta = { url, status: response.status, ms: Date.now() - startedAt };
      if (response.ok) {
        secureLog('info', 'Keep-warm ping ok', meta);
      } else {
        secureLog('warn', 'Keep-warm ping returned non-2xx', meta);
      }
      return { url, ok: response.ok, status: response.status };
    } catch (error) {
      secureLog('warn', 'Keep-warm ping failed', {
        url,
        ms: Date.now() - startedAt,
        message: error.name === 'TimeoutError' ? 'timeout' : error.message,
      });
      return { url, ok: false, error: error.message };
    }
  }

  async function runOnce() {
    try {
      if (!isInsideWindow(now(), windows, tz)) {
        return { skipped: true, results: [] };
      }
      const results = await Promise.all(urls.map(ping));
      return { skipped: false, results };
    } catch (error) {
      secureLog('error', 'Keep-warm job failed', { message: error.message });
      return { skipped: false, results: [], error: error.message };
    }
  }

  secureLog('info', 'Keep-warm job started', {
    urls: urls.length,
    intervalMs,
    tz,
    windows: env.KEEP_WARM_WINDOWS ?? DEFAULT_WINDOWS,
  });

  // Primera pasada diferida para no bloquear el boot.
  const initialTimeout = setTimeout(() => {
    runOnce();
  }, Math.min(intervalMs, 30_000));

  const timer = setInterval(() => {
    runOnce();
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  if (typeof initialTimeout.unref === 'function') initialTimeout.unref();

  return {
    runOnce,
    stop() {
      clearTimeout(initialTimeout);
      clearInterval(timer);
    },
  };
}

module.exports = {
  startKeepWarmJob,
  isInsideWindow,
  parseWindows,
  DEFAULT_TZ,
  DEFAULT_WINDOWS,
};
