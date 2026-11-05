const mockProducer = {
  connect: jest.fn(),
  send: jest.fn(),
  disconnect: jest.fn(),
};

const mockAdmin = {
  connect: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: jest.fn(() => mockProducer),
    admin: jest.fn(() => mockAdmin),
  })),
}));

const { Kafka } = require('kafkajs');
const { KafkaService, saslFromEnv } = require('../services/kafka.service');
const { ServiceUnavailableError } = require('../errors/app-errors');

describe('KafkaService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('isEnabled respeta options.enabled', () => {
    expect(new KafkaService({ enabled: false }).isEnabled()).toBe(false);
    expect(new KafkaService({ enabled: true }).isEnabled()).toBe(true);
  });

  it('connect no hace nada si está deshabilitado', async () => {
    const service = new KafkaService({ enabled: false });
    const result = await service.connect();
    expect(result).toBe(false);
    expect(mockProducer.connect).not.toHaveBeenCalled();
  });

  it('connect conecta el producer y marca connected=true', async () => {
    mockProducer.connect.mockResolvedValue(undefined);
    const service = new KafkaService({ enabled: true });
    const result = await service.connect();
    expect(result).toBe(true);
    expect(service.isConnected()).toBe(true);
  });

  it('connect captura errores y queda en modo degradado', async () => {
    mockProducer.connect.mockRejectedValue(new Error('no broker'));
    const service = new KafkaService({ enabled: true });
    const result = await service.connect();
    expect(result).toBe(false);
    expect(service.isConnected()).toBe(false);
  });

  it('checkHealth devuelve true si el admin conecta', async () => {
    mockAdmin.connect.mockResolvedValue(undefined);
    mockAdmin.disconnect.mockResolvedValue(undefined);
    const service = new KafkaService({ enabled: true });
    await expect(service.checkHealth()).resolves.toBe(true);
    expect(mockAdmin.disconnect).toHaveBeenCalled();
  });

  it('checkHealth devuelve false si el admin no conecta y no revienta al desconectar', async () => {
    mockAdmin.connect.mockRejectedValue(new Error('down'));
    mockAdmin.disconnect.mockRejectedValue(new Error('already down'));
    const service = new KafkaService({ enabled: true });
    await expect(service.checkHealth()).resolves.toBe(false);
  });

  it('publishEvent devuelve false sin lanzar si está deshabilitado', async () => {
    const service = new KafkaService({ enabled: false });
    await expect(service.publishEvent('topic', { a: 1 })).resolves.toBe(false);
  });

  it('publishEvent lanza ServiceUnavailableError si no está conectado', async () => {
    const service = new KafkaService({ enabled: true });
    await expect(service.publishEvent('topic', {})).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('publishEvent envía el mensaje cuando está conectado', async () => {
    mockProducer.connect.mockResolvedValue(undefined);
    mockProducer.send.mockResolvedValue(undefined);
    const service = new KafkaService({ enabled: true });
    await service.connect();

    const result = await service.publishEvent('topic', { a: 1 });

    expect(result).toBe(true);
    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: 'topic',
      messages: [{ key: null, value: JSON.stringify({ a: 1 }) }],
    });
  });

  it('publishEvent marca connected=false y repropaga si send falla', async () => {
    mockProducer.connect.mockResolvedValue(undefined);
    mockProducer.send.mockRejectedValue(new Error('broker gone'));
    const service = new KafkaService({ enabled: true });
    await service.connect();

    await expect(service.publishEvent('topic', {})).rejects.toThrow('broker gone');
    expect(service.isConnected()).toBe(false);
  });

  it('disconnect libera el producer si existe', async () => {
    mockProducer.connect.mockResolvedValue(undefined);
    mockProducer.disconnect.mockResolvedValue(undefined);
    const service = new KafkaService({ enabled: true });
    await service.connect();

    await service.disconnect();

    expect(mockProducer.disconnect).toHaveBeenCalled();
    expect(service.isConnected()).toBe(false);
  });

  it('disconnect no hace nada si no hay producer', async () => {
    const service = new KafkaService({ enabled: false });
    await expect(service.disconnect()).resolves.toBeUndefined();
    expect(mockProducer.disconnect).not.toHaveBeenCalled();
  });
});

describe('saslFromEnv (SASL/OAUTHBEARER contra el broker del gateway)', () => {
  it('sin secreto no configura SASL', () => {
    expect(saslFromEnv({})).toBeNull();
  });

  it('con secreto usa oauthbearer y pide el token al cliente', async () => {
    const authClient = { getToken: jest.fn().mockResolvedValue('jwt-1') };
    const sasl = saslFromEnv({ EDA_OAUTH_CLIENT_SECRET: 's' }, authClient);

    expect(sasl.mechanism).toBe('oauthbearer');
    await expect(sasl.oauthBearerProvider()).resolves.toEqual({ value: 'jwt-1' });
    expect(authClient.getToken).toHaveBeenCalledTimes(1);
  });

  it('por default pide el token al Login Federado con el cliente grupo5', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'jwt-2', expires_in: 900 }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const sasl = saslFromEnv({ EDA_OAUTH_CLIENT_SECRET: 'secreto' });
      await expect(sasl.oauthBearerProvider()).resolves.toEqual({ value: 'jwt-2' });
    } finally {
      globalThis.fetch = original;
    }
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.citypass-login.pp.ua/oauth/token');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('grupo5:secreto').toString('base64')}`);
    expect(init.body).toBe('grant_type=client_credentials');
  });

  it('KafkaService pasa sasl y ssl a kafkajs solo si están configurados', () => {
    const env = { ...process.env };
    try {
      delete process.env.EDA_OAUTH_CLIENT_SECRET;
      delete process.env.KAFKA_SSL;
      new KafkaService({ enabled: false });
      expect(Kafka.mock.calls.at(-1)[0].sasl).toBeUndefined();
      expect(Kafka.mock.calls.at(-1)[0].ssl).toBeUndefined();

      process.env.EDA_OAUTH_CLIENT_SECRET = 's';
      process.env.KAFKA_SSL = 'true';
      new KafkaService({ enabled: false, authClient: { getToken: jest.fn() } });
      expect(Kafka.mock.calls.at(-1)[0].sasl.mechanism).toBe('oauthbearer');
      expect(Kafka.mock.calls.at(-1)[0].ssl).toBe(true);
    } finally {
      process.env = env;
    }
  });
});

