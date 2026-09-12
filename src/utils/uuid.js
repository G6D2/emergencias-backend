const { validate: isUuid } = require('uuid');
const { ValidationError } = require('../errors/app-errors');

/**
 * Valida que `id` tenga formato UUID; si no, corta con ValidationError (400).
 *
 * Sin esto, un id mal formado llega tal cual a una query de Postgres contra
 * una columna uuid y Postgres tira un error de sintaxis (22P02) que el
 * middleware de errores termina devolviendo como 500 con mensaje crudo.
 * Usarlo al principio de cualquier controller que reciba un id de path param
 * antes de tocar el repository.
 *
 * @param {string} id
 * @param {string} [message]
 */
function assertUuid(id, message = 'Emergency id must be a valid UUID') {
  if (!isUuid(id)) {
    throw new ValidationError(message);
  }
}

module.exports = { assertUuid, isUuid };
