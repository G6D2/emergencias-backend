const mockEnd = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((config) => ({
    config,
    end: mockEnd,
    on: mockOn,
  })),
}));

// Handler registrado con pool.on(evento, handler) en el último getPool().
function poolHandler(event) {
  const call = mockOn.mock.calls.find(([name]) => name === event);
  return call && call[1];
}

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

  it('manda keepAlive y los timeouts de sesión con un Postgres directo', () => {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5434/emergencias_dev';
    const { getPool } = require('../db/pool');
    const { Pool } = require('pg');

    getPool();

    expect(Pool.mock.calls[0][0]).toMatchObject({
      keepAlive: true,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
  });

  it('contra el pooler de Neon no manda los timeouts como startup parameters (PgBouncer los rechaza)', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const { getPool } = require('../db/pool');
    const { Pool } = require('pg');

    getPool();

    const config = Pool.mock.calls[0][0];
    expect(config.keepAlive).toBe(true);
    expect(config).not.toHaveProperty('statement_timeout');
    expect(config).not.toHaveProperty('idle_in_transaction_session_timeout');
  });

  it('resolveSessionTimeouts: URL directa de Neon sí lleva timeouts; una URL inválida no rompe', () => {
    const { resolveSessionTimeouts } = require('../db/pool');

    expect(resolveSessionTimeouts('postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb'))
      .toEqual({ statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 });
    expect(resolveSessionTimeouts('no-es-una-url'))
      .toEqual({ statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 });
  });

  it("registra pool.on('error'): un client ocioso que se corta se loguea y no tira el proceso", () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const { getPool } = require('../db/pool');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    getPool();
    const onError = poolHandler('error');

    expect(typeof onError).toBe('function');
    expect(() => onError(new Error('Connection terminated unexpectedly'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('se cortó una conexión ociosa del pool'));
    errorSpy.mockRestore();
  });

  it("a cada client nuevo le agrega un listener de 'error' para cuando se corta estando prestado", () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const { getPool } = require('../db/pool');
    const { EventEmitter } = require('events');

    getPool();
    const client = new EventEmitter();
    poolHandler('connect')(client);

    expect(client.listenerCount('error')).toBe(1);
    // Sin ese listener, emit('error') lanzaría y tiraría el proceso.
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
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
