const { ConflictError } = require('../errors/app-errors');

// Máquina de estados de una emergency (tarea #10 del Task Tracker).
// Única fuente de verdad de los estados y las transiciones permitidas:
// la usan los controllers, el repository (defensa en profundidad) y swagger.
//
//                 ┌────────────────┐
//                 ▼                │   (DISPATCHED → VALIDATED: devolución para reasignar)
//   PENDING ──► VALIDATED ──► DISPATCHED ──► EN_ROUTE ──► ON_SCENE ──► RESOLVED ──► CLOSED
//      │                │
//      ├──► CANCELLED ◄─┘   (desde PENDING o VALIDATED)
//      └──► DISCARDED       (solo desde PENDING)
//
// Terminales (sin transiciones de salida): CANCELLED, DISCARDED, CLOSED.
const EMERGENCY_STATUSES = Object.freeze([
  'PENDING',
  'VALIDATED',
  'DISPATCHED',
  'EN_ROUTE',
  'ON_SCENE',
  'RESOLVED',
  'CLOSED',
  'CANCELLED',
  'DISCARDED',
]);

const TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(['VALIDATED', 'CANCELLED', 'DISCARDED']),
  VALIDATED: Object.freeze(['DISPATCHED', 'CANCELLED']),
  DISPATCHED: Object.freeze(['EN_ROUTE', 'VALIDATED']),
  EN_ROUTE: Object.freeze(['ON_SCENE']),
  ON_SCENE: Object.freeze(['RESOLVED']),
  RESOLVED: Object.freeze(['CLOSED']),
  CLOSED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  DISCARDED: Object.freeze([]),
});

const TERMINAL_STATUSES = Object.freeze(
  EMERGENCY_STATUSES.filter((status) => TRANSITIONS[status].length === 0)
);

const ACTIVE_STATUSES = Object.freeze(
  EMERGENCY_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status))
);

// Vista del oficial (GET /api/emergencies?scope=active|history, issue #17):
// en curso es lo que todavía tiene que atender; en el historial quedan las
// que resolvió, las que cerró el dispatcher y las que expiraron con él
// asignado. Las que le devolvieron (DISPATCHED → VALIDATED) también van al
// historial, pero no salen de un estado: el repository las busca por las
// asignaciones del historial de estados.
const OFFICER_SCOPE_STATUSES = Object.freeze({
  active: Object.freeze(['DISPATCHED', 'EN_ROUTE', 'ON_SCENE']),
  history: Object.freeze(['RESOLVED', 'CLOSED', 'CANCELLED']),
});

const OFFICER_SCOPES = Object.freeze(Object.keys(OFFICER_SCOPE_STATUSES));

// Expiración (solo el sistema, nunca un endpoint): una emergencia abierta que
// pasa el plazo de retención sin cambios de estado termina sola. Lo resuelto
// se cierra; todo lo demás se cancela, incluso lo ya despachado, que por la
// tabla de arriba no tiene salida directa a un estado terminal.
const EXPIRATION_TARGETS = Object.freeze({
  PENDING: 'CANCELLED',
  VALIDATED: 'CANCELLED',
  DISPATCHED: 'CANCELLED',
  EN_ROUTE: 'CANCELLED',
  ON_SCENE: 'CANCELLED',
  RESOLVED: 'CLOSED',
});

/** Estado terminal al que expira una emergencia en `status`; null si ya terminó. */
function expirationTarget(status) {
  return EXPIRATION_TARGETS[status] || null;
}

function isValidStatus(status) {
  return typeof status === 'string' && EMERGENCY_STATUSES.includes(status);
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function canTransition(from, to) {
  if (!isValidStatus(from) || !isValidStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/**
 * Lanza ConflictError (409) si la transición no está permitida.
 * El mensaje distingue estado desconocido, estado terminal y salto de flujo
 * para que el cliente sepa qué falló.
 */
function assertTransition(from, to) {
  if (!isValidStatus(to)) {
    throw new ConflictError(`Estado de emergencia desconocido: ${String(to)}`);
  }
  if (!isValidStatus(from)) {
    throw new ConflictError(`Estado de emergencia desconocido: ${String(from)}`);
  }
  if (isTerminal(from)) {
    throw new ConflictError(`La emergencia está en un estado final (${from}) y no puede pasar a ${to}`);
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(`Transición inválida: ${from} → ${to}`);
  }
}

module.exports = {
  EMERGENCY_STATUSES,
  TRANSITIONS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  OFFICER_SCOPE_STATUSES,
  OFFICER_SCOPES,
  EXPIRATION_TARGETS,
  expirationTarget,
  isValidStatus,
  isTerminal,
  canTransition,
  assertTransition,
};
