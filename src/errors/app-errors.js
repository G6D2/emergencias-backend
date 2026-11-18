// Errores con statusCode explícito para que el middleware tire el HTTP
// que corresponde, y no siempre un 500.
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

class ServiceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.statusCode = 503;
  }
}

class UnauthorizedError extends Error {
  constructor(message = 'No autenticado') {
    super(message);
    this.name = 'UnauthorizedError';
    this.statusCode = 401;
  }
}

class ForbiddenError extends Error {
  constructor(message = 'Sin permiso') {
    super(message);
    this.name = 'ForbiddenError';
    this.statusCode = 403;
  }
}

module.exports = {
  NotFoundError,
  ConflictError,
  ValidationError,
  ServiceUnavailableError,
  UnauthorizedError,
  ForbiddenError,
};
