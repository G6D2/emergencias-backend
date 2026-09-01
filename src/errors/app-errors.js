// Errores con statusCode explícito para que el middleware de errores devuelva
// el código HTTP correcto en vez de siempre 500.
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

module.exports = { NotFoundError, ConflictError };
