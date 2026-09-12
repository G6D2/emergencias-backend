const mockEnd = jest.fn().mockResolvedValue(undefined);

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((config) => ({
    config,
    end: mockEnd,
  })),
}));

describe('db/pool', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('lanza si falta DATABASE_URL', () => {
    delete process.env.DATABASE_URL;
    const { getPool } = require('../db/pool');
    expect(() => getPool()).toThrow('DATABASE_URL no está definida');
  });

  it('crea el pool una sola vez (singleton) con SSL relajado por defecto', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    delete process.env.DATABASE_SSL;
    const { getPool } = require('../db/pool');
    const { Pool } = require('pg');

    const pool1 = getPool();
    const pool2 = getPool();

    expect(pool1).toBe(pool2);
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool.mock.calls[0][0].ssl).toEqual({ rejectUnauthorized: false });
  });

  it('limita el pool con timeouts sanos y max=10 por defecto (sin DB_POOL_MAX)', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    delete process.env.DB_POOL_MAX;
    const { getPool } = require('../db/pool');
    const { Pool } = require('pg');

    getPool();

    expect(Pool.mock.calls[0][0]).toMatchObject({
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  });

  it('usa DB_POOL_MAX cuando está definida', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.DB_POOL_MAX = '25';
    const { getPool } = require('../db/pool');
    const { Pool } = require('pg');

    getPool();

    expect(Pool.mock.calls[0][0].max).toBe(25);
  });

  it('ignora un DB_POOL_MAX inválido y usa el default (10)', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.DB_POOL_MAX = 'not-a-number';
    const { getPool } = require('../db/pool');
    const { Pool } = require('pg');

    getPool();

    expect(Pool.mock.calls[0][0].max).toBe(10);
  });

  it('desactiva SSL cuando DATABASE_SSL=false', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.DATABASE_SSL = 'false';
    const { getPool } = require('../db/pool');
    const { Pool } = require('pg');

    getPool();

    expect(Pool.mock.calls[0][0].ssl).toBe(false);
  });

  it('closePool cierra y resetea el singleton', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const { getPool, closePool } = require('../db/pool');
    const { Pool } = require('pg');

    getPool();
    await closePool();
    getPool();

    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledTimes(2);
  });

  it('closePool no hace nada si nunca se creó el pool', async () => {
    const { closePool } = require('../db/pool');
    await expect(closePool()).resolves.toBeUndefined();
    expect(mockEnd).not.toHaveBeenCalled();
  });
});

describe('db/connection', () => {
  it('reexporta lo mismo que db/pool', () => {
    jest.resetModules();
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const pool = require('../db/pool');
    const connection = require('../db/connection');
    expect(connection).toBe(pool);
  });
});
