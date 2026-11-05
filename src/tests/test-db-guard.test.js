const { assertSafeTestDatabaseUrl, isLocalHost } = require('./setup/test-db-guard');

// Guarda del global-setup de integración: TEST_DATABASE_URL solo puede
// apuntar a una base local, salvo ALLOW_REMOTE_TEST_DB=true explícito.
describe('assertSafeTestDatabaseUrl', () => {
  it.each([
    'postgresql://postgres:postgres@localhost:5432/emergencias_test',
    'postgresql://postgres:postgres@127.0.0.1:5432/emergencias_test',
    'postgresql://postgres:postgres@127.0.0.2:5432/emergencias_test',
    'postgresql://postgres:postgres@[::1]:5432/emergencias_test',
    'postgresql://postgres:postgres@db.localhost:5432/emergencias_test',
  ])('acepta una base local: %s', (url) => {
    expect(assertSafeTestDatabaseUrl(url, {})).toMatchObject({ remote: false });
  });

  it.each([
    'postgresql://user:secret@ep-cool-123.sa-east-1.aws.neon.tech/neondb?sslmode=require',
    'postgresql://postgres:postgres@10.0.0.5:5432/emergencias_test',
    'postgresql://postgres:postgres@postgres:5432/emergencias_test',
    'postgresql://postgres:postgres@localhost.example.com:5432/emergencias_test',
  ])('rechaza una base no local sin la variable explícita: %s', (url) => {
    expect(() => assertSafeTestDatabaseUrl(url, {})).toThrow(/ALLOW_REMOTE_TEST_DB=true/);
  });

  it('el mensaje no filtra la password de la URL', () => {
    const url = 'postgresql://user:super-secreta@ep-cool-123.neon.tech/neondb';
    expect(() => assertSafeTestDatabaseUrl(url, {})).toThrow(expect.objectContaining({
      message: expect.not.stringContaining('super-secreta'),
    }));
  });

  it('con ALLOW_REMOTE_TEST_DB=true deja pasar una base remota y lo marca', () => {
    const url = 'postgresql://user:secret@ep-cool-123.neon.tech/neondb';
    expect(assertSafeTestDatabaseUrl(url, { ALLOW_REMOTE_TEST_DB: 'true' }))
      .toEqual({ host: 'ep-cool-123.neon.tech', remote: true });
  });

  it('cualquier otro valor de ALLOW_REMOTE_TEST_DB no habilita nada', () => {
    const url = 'postgresql://user:secret@ep-cool-123.neon.tech/neondb';
    for (const value of ['1', 'yes', 'TRUE', '']) {
      expect(() => assertSafeTestDatabaseUrl(url, { ALLOW_REMOTE_TEST_DB: value })).toThrow();
    }
  });

  it('isLocalHost no se deja engañar por prefijos', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('LOCALHOST')).toBe(true);
    expect(isLocalHost('127.0.0.1.nip.io')).toBe(false);
    expect(isLocalHost('notlocalhost')).toBe(false);
    expect(isLocalHost('')).toBe(false);
  });
});
