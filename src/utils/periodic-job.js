/**
 * Programa un job en background: una primera pasada diferida, para no bloquear
 * el arranque, y después una por intervalo. Los timers no retienen el proceso.
 *
 * `runOnce` no tiene que rechazar: cada job captura y loguea sus propios
 * errores. Por eso la promesa se descarta con `void`, a propósito.
 */
function schedulePeriodicJob(runOnce, { intervalMs, firstRunDelayMs = 15_000 }) {
  const initialTimeout = setTimeout(() => {
    void runOnce();
  }, Math.min(intervalMs, firstRunDelayMs));

  const timer = setInterval(() => {
    void runOnce();
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

module.exports = { schedulePeriodicJob };
