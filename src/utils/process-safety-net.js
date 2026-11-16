const { secureLog } = require('../security/secure-log');

function describeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

/**
 * Red de seguridad del proceso: lo que nadie capturó queda en el log con el
 * mismo formato que el resto (secureLog).
 *
 * - unhandledRejection: se loguea y el proceso SIGUE. Sin este handler Node
 *   termina el proceso ante un rechazo sin catch (default desde Node 15); en
 *   Render free eso es cerca de un minuto de arranque en frío por un error
 *   que afectó a una sola operación.
 * - uncaughtException: se loguea y el proceso termina con código 1. Después
 *   de una excepción no capturada el estado no es confiable; Render lo
 *   vuelve a levantar.
 *
 * @param {NodeJS.Process} [proc] inyectable para tests
 */
function installProcessSafetyNet(proc = process) {
  proc.on('unhandledRejection', (reason) => {
    secureLog('error', 'Rechazo de promesa sin capturar: el proceso sigue', describeError(reason));
  });

  proc.on('uncaughtException', (error) => {
    secureLog('error', 'Excepción no capturada: el proceso termina', describeError(error));
    proc.exit(1);
  });
}

module.exports = { installProcessSafetyNet };
