const { secureLog } = require('../security/secure-log');

// Espera entre reintentos: 5 s, 30 s, 2 min y de ahí cada 2 min (tope). Un
// listener que no pudo conectarse al bus (broker caído, token del Login
// Federado que no sale) no queda muerto hasta el próximo deploy.
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000]);

/**
 * Arranca algo con start()/stop()/status()/onCrash (hoy, el EventConsumer
 * que lee todos los topics) y lo mantiene arriba: si start() falla, o si el consumer
 * se cae sin que kafkajs lo reinicie (CRASH sin restart), lo vuelve a
 * levantar con backoff. Devuelve un handle con status() para GET /health y
 * stop() para el shutdown.
 *
 * Estados: starting (primer intento), running, retrying (ya falló al menos
 * una vez y no volvió a arrancar), disabled (sin topic configurado: no hay
 * nada que reintentar) y stopped.
 */
function superviseListener(listener, { retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
  const name = listener.constructor.name;
  let state = 'starting';
  let failures = 0;
  let timer = null;
  let nextRetryAt = null;
  let stopped = false;

  function scheduleRetry(error) {
    if (stopped) return;
    const delayMs = retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)];
    failures += 1;
    state = 'retrying';
    nextRetryAt = new Date(Date.now() + delayMs);
    secureLog('error', 'Listener caído, se reintenta', {
      listener: name,
      attempt: failures,
      retryInMs: delayMs,
      message: error?.message,
    });
    timer = setTimeout(attempt, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function attempt() {
    timer = null;
    nextRetryAt = null;
    // Conectar al bus puede tardar más de un minuto en fallar (kafkajs
    // reintenta adentro): mientras tanto, si ya falló antes, sigue en retrying.
    state = failures === 0 ? 'starting' : 'retrying';
    try {
      const started = await listener.start();
      if (stopped) return;
      state = started ? 'running' : 'disabled';
      failures = 0;
    } catch (error) {
      scheduleRetry(error);
    }
  }

  listener.onCrash = scheduleRetry;
  const ready = attempt();

  return {
    // Resuelve cuando termina el primer intento (lo usan los tests).
    ready,
    status() {
      return {
        ...listener.status(),
        status: state,
        nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
      };
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      nextRetryAt = null;
      state = 'stopped';
      await listener.stop();
    },
  };
}

module.exports = { superviseListener, DEFAULT_RETRY_DELAYS_MS };
