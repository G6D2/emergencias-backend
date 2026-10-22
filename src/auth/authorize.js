const { UnauthorizedError, ForbiddenError } = require('../errors/app-errors');
const { GROUPS } = require('./groups');

function userHasGroup(user, group) {
  if (!Array.isArray(user?.groups)) return false;
  return user.groups.some((g) => {
    if (typeof g !== 'string') return false;
    const lower = g.toLowerCase();
    if (lower === group.toLowerCase()) return true;
    if (group === GROUPS.DISPATCHER && lower === 'delegados') return true;
    return false;
  });
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
const requireDispatcher = createRequireGroups(GROUPS.DISPATCHER);
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
  requireDispatcher,
  requireCitizenOrDispatcher,
};
