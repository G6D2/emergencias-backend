// Los tests unitarios reusan la misma app/IP para muchos requests seguidos
// (p. ej. varios POST /api/panic-button en el mismo describe), así que el
// rate limiting viene apagado por default. Un test que quiera ejercitar el
// límite real puede pisar la variable (jest.resetModules() + re-require,
// como hace src/tests/pool.test.js con DATABASE_SSL).
if (process.env.RATE_LIMIT_ENABLED === undefined) {
  process.env.RATE_LIMIT_ENABLED = 'false';
}

// Varios tests miran lo que sale por consola (secureLog) y asumen el nivel por
// default (info): un LOG_LEVEL exportado en la terminal no debe cambiarles el
// resultado. El test de secure-log lo define cuando lo necesita.
delete process.env.LOG_LEVEL;
