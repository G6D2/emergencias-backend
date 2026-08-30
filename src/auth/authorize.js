const { UnauthorizedError, ForbiddenError } = require('../errors/app-errors');
const { GROUPS } = require('./groups');

function userHasGroup(user, group) {
  return Array.isArray(user?.groups) && user.groups.includes(group);
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

const requireCitizen = createRequireGroups(GROUPS.CITIZEN);
const requireCitizenOrDispatcher = createRequireGroups(
  GROUPS.CITIZEN,
  GROUPS.DISPATCHER
);

module.exports = {
  createRequireGroups,
  userHasGroup,
  userHasAnyGroup,
  canViewEmergency,
  canCancelEmergency,
  requireCitizen,
  requireCitizenOrDispatcher,
};
