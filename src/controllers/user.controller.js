class UserController {
  getCurrentUser(user) {
    return {
      success: true,
      data: {
        sub: user.sub,
        username: user.username,
        groups: user.groups,
        module: user.module,
        hasAntipanicButton: user.hasAntipanicButton,
        // Solo AUTH_MODE=hybrid (undefined en local/idp, no sale en el JSON).
        authSource: user.authSource,
        idpSub: user.idpSub,
        idpGroups: user.idpGroups,
      },
    };
  }
}

module.exports = { UserController };
