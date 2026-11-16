const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { ValidationError, ConflictError, UnauthorizedError } = require('../errors/app-errors');
const { BCRYPT_ROUNDS } = require('../repositories/auth-user.repository');

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

// Hash bcrypt de relleno, con el mismo costo que los reales: si el correo no
// existe, el login compara igual contra este hash, así el 401 tarda lo mismo
// que con una contraseña incorrecta y no se pueden enumerar cuentas midiendo
// la respuesta.
//
// Se calcula en el primer login y queda memorizado. Antes era un
// bcrypt.hashSync al cargar el módulo, que bloqueaba el arranque. Se guarda la
// promesa (dos logins simultáneos no lo calculan dos veces) y, si el cálculo
// falla, no queda memorizado el error: el próximo login lo reintenta.
let dummyPasswordHash = null;

function getDummyPasswordHash() {
  if (!dummyPasswordHash) {
    dummyPasswordHash = bcrypt.hash(randomUUID(), BCRYPT_ROUNDS).catch((error) => {
      dummyPasswordHash = null;
      throw error;
    });
  }
  return dummyPasswordHash;
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
    // Se pide siempre, exista o no el correo: el costo de calcularlo (solo en
    // el primer login) no tiene que delatar si la cuenta existe.
    const dummyHash = await getDummyPasswordHash();
    const passwordHash = (found && found.passwordHash) || dummyHash;
    const ok = await this.authUserRepository.verifyPassword(passwordHash, password);
    if (!found || !ok) {
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
