/**
 * Compat con el entry point viejo del pipeline.
 * Preferí usar `getPool()` / `closePool()` desde `./pool`.
 */
module.exports = require('./pool');
