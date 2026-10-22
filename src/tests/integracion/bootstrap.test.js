// Mocks de kafkajs y modulos de arranque para no abrir conexiones reales.
const mockConsumer = {
  connect: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  run: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: jest.fn(() => mockConsumer),
  })),
}));

const { buildIntegracionListener, DEFAULT_UMBRAL_CAPACIDAD } = require('../../integracion/bootstrap');

describe('buildIntegracionListener', () => {
  const baseEnv = (overrides = {}) => ({
    KAFKA_CONSUMER_ENABLED: 'true',
    EDA_TOPIC_EVENTO_PUBLICADO: 'com.citypass.turismo.EventoComunitarioPublicado',
    EDA_TOPIC_EVENTO_CANCELADO: 'com.citypass.turismo.EventoCancelado',
    EDA_AUTH_URL: 'https://gateway/auth/oauth/token',
    EDA_CLIENT_ID: 'grupo5',
    EDA_CLIENT_SECRET: 'grupo5',
    UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA: '500',
    ...overrides,
  });

  const makeDeps = () => ({
    pool: { connect: jest.fn(), query: jest.fn() },
    kafkaService: { publishEvent: jest.fn() },
    locationCrypto: { encryptLocation: jest.fn() },
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DEFAULT_UMBRAL_CAPACIDAD exportado y > 0', () => {
    expect(DEFAULT_UMBRAL_CAPACIDAD).toBeGreaterThan(0);
  });

  it('devuelve no-op con enabled=false si KAFKA_CONSUMER_ENABLED!=true', async () => {
    const result = buildIntegracionListener({ ...makeDeps(), env: { KAFKA_CONSUMER_ENABLED: 'false' } });
    expect(result.enabled).toBe(false);
    await expect(result.start()).resolves.toBe(false);
    await expect(result.stop()).resolves.toBeUndefined();
  });

  it('devuelve no-op si no hay topics configurados', () => {
    const result = buildIntegracionListener({
      ...makeDeps(),
      env: { KAFKA_CONSUMER_ENABLED: 'true' },
    });
    expect(result.enabled).toBe(false);
  });

  it('lanza si UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA es invalido', () => {
    expect(() => buildIntegracionListener({
      ...makeDeps(),
      env: baseEnv({ UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA: 'nope' }),
    })).toThrow(/UMBRAL_CAPACIDAD/);
  });

  it('construye un listener enabled con topics y arranca el consumer', async () => {
    const deps = makeDeps();
    const integracion = buildIntegracionListener({ ...deps, env: baseEnv() });
    expect(integracion.enabled).toBe(true);

    await integracion.start();

    expect(mockConsumer.connect).toHaveBeenCalled();
    const subscribedTopics = mockConsumer.subscribe.mock.calls.map((c) => c[0].topic).sort();
    expect(subscribedTopics).toEqual([
      'com.citypass.turismo.EventoCancelado',
      'com.citypass.turismo.EventoComunitarioPublicado',
    ]);

    await integracion.stop();
    expect(mockConsumer.disconnect).toHaveBeenCalled();
  });

  it('arranca aun si falta uno de los dos topics (filtra undefined)', async () => {
    const deps = makeDeps();
    const integracion = buildIntegracionListener({
      ...deps,
      env: baseEnv({ EDA_TOPIC_EVENTO_CANCELADO: undefined }),
    });
    expect(integracion.enabled).toBe(true);
    await integracion.start();
    expect(mockConsumer.subscribe).toHaveBeenCalledTimes(1);
    expect(mockConsumer.subscribe.mock.calls[0][0].topic).toBe('com.citypass.turismo.EventoComunitarioPublicado');
  });

  it('start captura errores del consumer y devuelve false sin tumbar el server', async () => {
    mockConsumer.connect.mockRejectedValueOnce(new Error('no broker'));
    const integracion = buildIntegracionListener({ ...makeDeps(), env: baseEnv() });
    await expect(integracion.start()).resolves.toBe(false);
  });

  it('arranca sin SASL si faltan credenciales (consumer sin auth)', async () => {
    const integracion = buildIntegracionListener({
      ...makeDeps(),
      env: baseEnv({ EDA_CLIENT_ID: undefined, EDA_CLIENT_SECRET: undefined, EDA_AUTH_URL: undefined }),
    });
    expect(integracion.enabled).toBe(true);
    await integracion.start();
    expect(mockConsumer.connect).toHaveBeenCalled();
  });
});
