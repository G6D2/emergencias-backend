// Capa de selección de estrategia de agrupamiento (tarea #61, parte 1/2,
// ADR-002 "IncidentDetectionStrategy"). Módulo puro: no conoce Postgres ni
// Kafka, solo decide entre una estrategia primaria y una de fallback.

const { secureLog } = require('../security/secure-log');

/**
 * Corre `primary(candidates, options)` y cae a `fallback(candidates, options)`
 * solo ante una falla técnica de `primary` (excepción sync o promesa
 * rechazada) — nunca porque el resultado sea un array vacío: eso es una
 * respuesta válida ("no hay grupos que formar ahora"), no un error.
 *
 * Si `fallback` también falla, la excepción se propaga sin capturarla: no
 * hay un tercer nivel de respaldo, y silenciarla ocultaría un problema real.
 *
 * @param {Array<object>} candidates
 * @param {object} options
 * @param {{ primary: Function, fallback: Function }} strategies funciones
 *   con la firma (candidates, options) => string[][] (array de arrays de
 *   emergencyId), sync o async indistintamente.
 * @returns {Promise<{ groups: string[][], strategy: 'primary' | 'fallback' }>}
 */
async function detectGroups(candidates, options, { primary, fallback }) {
  try {
    const groups = await primary(candidates, options);
    return { groups, strategy: 'primary' };
  } catch (error) {
    secureLog('warn', 'Incident detection primary strategy failed, using fallback', {
      message: error.message,
    });
    const groups = await fallback(candidates, options);
    return { groups, strategy: 'fallback' };
  }
}

module.exports = { detectGroups };
