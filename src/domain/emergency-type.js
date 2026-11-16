const { ValidationError } = require('../errors/app-errors');

// Catálogo cerrado de tipos de emergencia (tarea #44 del Task Tracker).
// Nomenclatura en español mayúsculas, alineada con los Casos de Uso y los
// ADRs de incidentes (G6D2/ADRs#10). Única fuente de verdad: la usan el
// controller del botón de pánico, el filtro del listado, swagger y el
// CHECK de la migración V10.
//
// PANICO representa hoy el botón SOS (sin categoría declarada). Conceptualmente
// es un "origen" de la emergencia y no un tipo: cuando se modele el origen como
// campo propio, PANICO se separa de este catálogo.
//
// PREVENTIVA la crea solo el sistema: despliegue preventivo ante un evento
// público masivo (cobertura preventiva del listener de Espacios). No se puede
// reportar desde el botón de pánico.
//
// TRANSITO: obstrucción de la vía (ej. un auto en la ciclovía). Hoy nace de un
// reclamo de Reclamos (listener reclamo-intervencion).
const EMERGENCY_TYPES = Object.freeze([
  'MEDICA',
  'INCENDIO',
  'INFRAESTRUCTURA',
  'DISTURBIO_EVENTO_MASIVO',
  'OTRO',
  'PANICO',
  'PREVENTIVA',
  'TRANSITO',
]);

// Alias que manda el frontend hoy (en inglés, minúscula). Se aceptan por
// compatibilidad hasta que el PR de nomenclatura alinee al cliente.
const EMERGENCY_TYPE_ALIASES = Object.freeze({
  panic: 'PANICO',
  medical: 'MEDICA',
  fire: 'INCENDIO',
  infrastructure: 'INFRAESTRUCTURA',
  disturbance: 'DISTURBIO_EVENTO_MASIVO',
  other: 'OTRO',
});

/**
 * Lleva un valor de entrada al canónico del catálogo.
 * Acepta el canónico en cualquier casing, los alias del frontend y espacios
 * alrededor. Devuelve null si el valor no corresponde a ningún tipo.
 */
function normalizeEmergencyType(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (EMERGENCY_TYPES.includes(upper)) return upper;

  return EMERGENCY_TYPE_ALIASES[trimmed.toLowerCase()] || null;
}

/**
 * Normaliza o lanza ValidationError (400) con la lista de valores válidos.
 * Un valor ausente (undefined/null/'') devuelve null: cada caller decide el default.
 */
function assertEmergencyType(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return null;
  }

  const normalized = normalizeEmergencyType(value);
  if (!normalized) {
    throw new ValidationError(
      `Invalid emergencyType ${JSON.stringify(value)}. Valid values: ${EMERGENCY_TYPES.join(', ')}`
    );
  }
  return normalized;
}

module.exports = {
  EMERGENCY_TYPES,
  EMERGENCY_TYPE_ALIASES,
  normalizeEmergencyType,
  assertEmergencyType,
};
