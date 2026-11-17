/**
 * Programa un job en background: una primera pasada diferida, para no bloquear
 * el arranque, y después una por intervalo. Los timers no retienen el proceso.
 *
 * Las corridas no se solapan: si al llegar un tick la anterior todavía no
 * terminó (la base lenta, un lote grande), ese tick se saltea y el job vuelve
 * a correr en el siguiente.
 *
 * `runOnce` no tiene que rechazar: cada job captura y loguea sus propios
 * errores. Por eso la promesa se descarta con `void`, a propósito.
 */
function schedulePeriodicJob(runOnce, { intervalMs, firstRunDelayMs = 15_000 }) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  }

  const initialTimeout = setTimeout(() => {
    void tick();
  }, Math.min(intervalMs, firstRunDelayMs));

  const timer = setInterval(() => {
    void tick();
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
