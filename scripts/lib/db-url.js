function parseDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);

  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('DATABASE_URL debe incluir el nombre de la base de datos (ej: .../postgres)');
  }

  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

module.exports = { parseDatabaseUrl };
