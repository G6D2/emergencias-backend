class UserController {
  getCurrentUser(user) {
    return {
      success: true,
      data: {
        sub: user.sub,
        username: user.username,
        groups: user.groups,
        module: user.module,
      },
    };
  }
}

module.exports = { UserController };
