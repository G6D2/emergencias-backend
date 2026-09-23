const { ValidationError, ConflictError, UnauthorizedError } = require('../errors/app-errors');

// Anclado a forma típica de email; evita cuantificadores anidados (Sonar S5852).
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveDisplayName(body) {
  if (typeof body.preferred_username === 'string') {
    return body.preferred_username;
  }
  if (typeof body.displayName === 'string') {
    return body.displayName;
  }
  return undefined;
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
    const displayName = resolveDisplayName(body);

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
