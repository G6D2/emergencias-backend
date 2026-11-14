const { UnauthorizedError, ForbiddenError } = require('../errors/app-errors');
const { GROUPS } = require('./groups');

function normalizeGroup(group) {
  return typeof group === 'string' ? group.trim().toLowerCase() : '';
}

/**
 * ¿El usuario está en `group`? Ignora mayúsculas y espacios de los costados
 * (idea del PR #65): 'Dispatcher' y 'dispatcher' son el mismo grupo. Un grupo
 * vacío o que no es string nunca coincide.
 */
function userHasGroup(user, group) {
  const wanted = normalizeGroup(group);
  if (!wanted || !Array.isArray(user?.groups)) {
    return false;
  }
  return user.groups.some((g) => normalizeGroup(g) === wanted);
}

function userHasAnyGroup(user, allowedGroups) {
  return allowedGroups.some((group) => userHasGroup(user, group));
}

/**
 * Middleware: exige al menos uno de los grupos del IdP (post-authenticate).
 */
function createRequireGroups(...allowedGroups) {
  return function requireGroups(req, res, next) {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }

    if (!userHasAnyGroup(req.user, allowedGroups)) {
      next(new ForbiddenError('Insufficient group membership'));
      return;
    }

    next();
  };
}

function canViewEmergency(user, emergency) {
  if (userHasGroup(user, GROUPS.DISPATCHER)) {
    return true;
  }

  if (userHasGroup(user, GROUPS.CITIZEN)) {
    return emergency.userId === user.sub;
  }

  return false;
}

function canCancelEmergency(user, emergency) {
  if (!userHasGroup(user, GROUPS.CITIZEN)) {
    return false;
  }

  return emergency.userId === user.sub;
}

/**
 * Quién puede avanzar el estado operativo (EN_ROUTE → ON_SCENE → RESOLVED):
 * solo el oficial actualmente asignado a la emergencia (HU-08, issue #21).
 *
 * Es el ÚNICO lugar donde vive esa regla. Si Producto decide que lo avanza el
 * dispatcher (ver issue #85), se cambia acá y en el middleware de la ruta, sin
 * tocar el controller ni el repository.
 *
 * El sub del token se compara contra emergencies.assigned_officer_id (el id
 * del catálogo de oficiales). El token de desarrollo de un oficial lleva como
 * sub el id del catálogo (ej. 'of-001'); un oficial que entra por el Login
 * Federado (AUTH_MODE=hybrid) llega con su sub ya traducido por
 * IDP_SUB_ALIASES en authenticate (ver federated-claims.js, issue #75).
 */
function canAdvanceEmergencyStatus(user, emergency) {
  if (!userHasGroup(user, GROUPS.OFFICER)) {
    return false;
  }

  return Boolean(emergency.assignedOfficerId) && emergency.assignedOfficerId === user.sub;
}

const requireCitizen = createRequireGroups(GROUPS.CITIZEN);
const requireDispatcher = createRequireGroups(GROUPS.DISPATCHER);
const requireOfficer = createRequireGroups(GROUPS.OFFICER);
const requireCitizenOrDispatcher = createRequireGroups(
  GROUPS.CITIZEN,
  GROUPS.DISPATCHER
);
const requireCitizenDispatcherOrOfficer = createRequireGroups(
  GROUPS.CITIZEN,
  GROUPS.DISPATCHER,
  GROUPS.OFFICER
);

module.exports = {
  createRequireGroups,
  userHasGroup,
  userHasAnyGroup,
  canViewEmergency,
  canCancelEmergency,
  canAdvanceEmergencyStatus,
  requireCitizen,
  requireDispatcher,
  requireOfficer,
  requireCitizenOrDispatcher,
  requireCitizenDispatcherOrOfficer,
};
