const { secureLog } = require('../security/secure-log');

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Apagado ordenado (Render manda SIGTERM en cada deploy y al dormir el
 * servicio): corre los pasos en orden y, si uno falla, lo loguea y sigue con
 * el próximo. Con un tope de tiempo para no colgar el apagado si algo no
 * responde (un request que no termina, el broker caído).
 *
 * @param {Array<{ name: string, run: () => Promise<unknown> }>} steps
 * @returns {Promise<0|1>} código de salida: 1 si venció el tope
 */
async function gracefulShutdown(steps, { timeoutMs = 10_000 } = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const run = (async () => {
    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        secureLog('error', `Shutdown: falló ${step.name}`, { message: error.message });
      }
    }
    return 'done';
  })();

  const result = await Promise.race([run, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') {
    secureLog('error', 'Shutdown: no terminó a tiempo, se fuerza la salida', { timeoutMs });
    return 1;
  }
  return 0;
}

module.exports = { gracefulShutdown, closeServer };
