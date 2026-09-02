const {
  createRequireGroups,
  userHasGroup,
  canViewEmergency,
  canCancelEmergency,
} = require('../auth/authorize');
const { GROUPS } = require('../auth/groups');
const { ForbiddenError, UnauthorizedError } = require('../errors/app-errors');

describe('authorize', () => {
  describe('createRequireGroups', () => {
    const requireCitizen = createRequireGroups(GROUPS.CITIZEN);

    it('passes when user has required group', () => {
      const req = { user: { sub: 'U1', groups: ['citizen'] } };
      const next = jest.fn();
      requireCitizen(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('returns 403 when group is missing', () => {
      const req = { user: { sub: 'U1', groups: ['dispatcher'] } };
      const next = jest.fn();
      requireCitizen(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('returns 403 when groups is empty', () => {
      const req = { user: { sub: 'U1', groups: [] } };
      const next = jest.fn();
      requireCitizen(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('returns 401 when user is missing', () => {
      const req = {};
      const next = jest.fn();
      requireCitizen(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });
  });

  describe('canViewEmergency', () => {
    const emergency = { userId: 'U000042' };

    it('dispatcher can view any emergency', () => {
      expect(canViewEmergency({ sub: 'U999', groups: ['dispatcher'] }, emergency)).toBe(true);
    });

    it('citizen can view own emergency', () => {
      expect(canViewEmergency({ sub: 'U000042', groups: ['citizen'] }, emergency)).toBe(true);
    });

    it('citizen cannot view others emergency', () => {
      expect(canViewEmergency({ sub: 'U000099', groups: ['citizen'] }, emergency)).toBe(false);
    });
  });

  describe('canCancelEmergency', () => {
    const emergency = { userId: 'U000042' };

    it('citizen can cancel own emergency', () => {
      expect(canCancelEmergency({ sub: 'U000042', groups: ['citizen'] }, emergency)).toBe(true);
    });

    it('citizen cannot cancel others emergency', () => {
      expect(canCancelEmergency({ sub: 'U000099', groups: ['citizen'] }, emergency)).toBe(false);
    });

    it('dispatcher cannot cancel via citizen endpoint', () => {
      expect(canCancelEmergency({ sub: 'U999', groups: ['dispatcher'] }, emergency)).toBe(false);
    });
  });

  describe('userHasGroup', () => {
    it('ignores unknown groups without failing', () => {
      expect(userHasGroup({ groups: ['equipo-desconocido'] }, 'citizen')).toBe(false);
    });
  });
});
