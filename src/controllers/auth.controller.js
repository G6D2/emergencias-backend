const { ValidationError, ConflictError, UnauthorizedError } = require('../errors/app-errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

class AuthController {
  constructor(authUserRepository, tokenIssuer) {
    this.authUserRepository = authUserRepository;
    this.tokenIssuer = tokenIssuer;
  }

  async register(body = {}) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object');
    }

    const email = normalizeEmail(body.email);
    const password = body.password;
    const displayName = typeof body.preferred_username === 'string'
      ? body.preferred_username
      : (typeof body.displayName === 'string' ? body.displayName : undefined);

    if (!email || !EMAIL_RE.test(email)) {
      throw new ValidationError('email must be a valid email address');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const existing = await this.authUserRepository.findByEmail(email);
    if (existing) {
      throw new ConflictError('El correo ya está en uso.');
    }

    const user = await this.authUserRepository.create({
      email,
      password,
      displayName,
      groups: ['citizen'],
      hasAntipanicButton: false,
    });

    const tokens = await this.tokenIssuer.issueAccessToken({
      sub: user.id,
      preferred_username: user.displayName,
      groups: user.groups,
      has_antipanic_button: user.hasAntipanicButton,
    });

    return {
      ...tokens,
      user: {
        sub: user.id,
        username: user.displayName,
        groups: user.groups,
        hasAntipanicButton: user.hasAntipanicButton,
      },
    };
  }

  async login(body = {}) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Body must be a JSON object');
    }

    const email = normalizeEmail(body.email);
    const password = body.password;

    if (!email || typeof password !== 'string') {
      throw new ValidationError('email and password are required');
    }

    const found = await this.authUserRepository.findByEmail(email);
    if (!found) {
      throw new UnauthorizedError('Correo o contraseña incorrectos.');
    }

    const ok = await this.authUserRepository.verifyPassword(found.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedError('Correo o contraseña incorrectos.');
    }

    const tokens = await this.tokenIssuer.issueAccessToken({
      sub: found.id,
      preferred_username: found.displayName,
      groups: found.groups,
      has_antipanic_button: found.hasAntipanicButton,
    });

    return {
      ...tokens,
      user: {
        sub: found.id,
        username: found.displayName,
        groups: found.groups,
        hasAntipanicButton: found.hasAntipanicButton,
      },
    };
  }
}

module.exports = { AuthController, MIN_PASSWORD_LENGTH, EMAIL_RE };
