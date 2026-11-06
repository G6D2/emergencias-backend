const mockProducer = {
  connect: jest.fn(),
  send: jest.fn(),
  disconnect: jest.fn(),
};

const mockAdmin = jest.fn();

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: jest.fn(() => mockProducer),
    admin: mockAdmin,
  })),
}));

const { Kafka } = require('kafkajs');
const {
  KafkaService, saslFromEnv, edaAuthClientFromEnv, kafkaHealth,
} = require('../services/kafka.service');
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

  it('reconectar descarta el producer anterior en vez de dejarlo abierto', async () => {
    mockProducer.connect.mockResolvedValue(undefined);
    mockProducer.disconnect.mockRejectedValue(new Error('ya estaba caído'));
    const service = new KafkaService({ enabled: true });
    await service.connect();
    expect(mockProducer.disconnect).not.toHaveBeenCalled();

    await expect(service.connect()).resolves.toBe(true);

    expect(mockProducer.disconnect).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(true);
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

describe('kafkaHealth (estado en memoria para GET /health)', () => {
  const service = ({ enabled = true, connected = false } = {}) => ({
    isEnabled: () => enabled,
    isConnected: () => connected,
  });
  const listener = (status, extra = {}) => ({
    name: 'L', running: status === 'running', status, lastPollAt: null, nextRetryAt: null, ...extra,
  });
  const outbox = (enabled, lastPollAt = null) => ({ enabled, lastPollAt });

  it('no abre conexiones: nunca crea un admin del broker', () => {
    kafkaHealth(new KafkaService({ enabled: true }), { outbox: outbox(true), listeners: [listener('running')] });
    expect(mockAdmin).not.toHaveBeenCalled();
  });

  it('KAFKA_ENABLED=false: disabled', () => {
    expect(kafkaHealth(service({ enabled: false }), { outbox: outbox(true) })).toMatchObject({
      kafka: 'disabled',
      outbox: { enabled: true, producerConnected: false },
    });
  });

  it('prod hoy (solo consumir): connected si cada listener con topic corre, sin mirar el producer', () => {
    const health = kafkaHealth(service({ connected: false }), {
      outbox: outbox(false),
      listeners: [listener('running'), listener('running'), listener('disabled')],
    });

    expect(health.kafka).toBe('connected');
    expect(health.outbox).toEqual({ enabled: false, lastPollAt: null, producerConnected: false });
    expect(health.listeners).toHaveLength(3);
  });

  it('un listener reintentando lo deja disconnected', () => {
    const health = kafkaHealth(service(), {
      outbox: outbox(false),
      listeners: [listener('running'), listener('retrying', { nextRetryAt: '2026-11-05T12:00:30.000Z' })],
    });

    expect(health.kafka).toBe('disconnected');
    expect(health.listeners[1]).toMatchObject({ status: 'retrying', nextRetryAt: '2026-11-05T12:00:30.000Z' });
  });

  it('con el outbox publicando, el producer también tiene que estar conectado', () => {
    const lastPollAt = '2026-11-05T12:00:00.000Z';
    expect(kafkaHealth(service({ connected: true }), { outbox: outbox(true, lastPollAt) })).toEqual({
      kafka: 'connected',
      outbox: { enabled: true, lastPollAt, producerConnected: true },
      listeners: [],
    });
    expect(kafkaHealth(service({ connected: false }), { outbox: outbox(true) }).kafka).toBe('disconnected');
  });

  it('con el outbox publicando por el gateway no exige el producer (prod desde el 05/11)', () => {
    const health = kafkaHealth(service({ connected: false }), {
      outbox: { enabled: true, publisher: 'gateway', lastPollAt: null },
      listeners: [listener('running'), listener('running')],
    });

    expect(health.kafka).toBe('connected');
    expect(health.outbox).toMatchObject({ enabled: true, publisher: 'gateway', producerConnected: false });
  });

  it('con el gateway publicando y un listener caído, disconnected', () => {
    const health = kafkaHealth(service(), {
      outbox: { enabled: true, publisher: 'gateway', lastPollAt: null },
      listeners: [listener('running'), listener('retrying')],
    });
    expect(health.kafka).toBe('disconnected');
  });

  it('Kafka prendido sin nada que lo use: disconnected', () => {
    expect(kafkaHealth(service({ connected: true })).kafka).toBe('disconnected');
  });

  it('sin kafkaService: disabled', () => {
    expect(kafkaHealth(null).kafka).toBe('disabled');
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

describe('edaAuthClientFromEnv', () => {
  it('sin secreto no arma cliente', () => {
    expect(edaAuthClientFromEnv({})).toBeNull();
  });

  it('con secreto usa el Login Federado y grupo5 por default', () => {
    const client = edaAuthClientFromEnv({ EDA_OAUTH_CLIENT_SECRET: 'x' });
    expect(client.isConfigured()).toBe(true);
    expect(client.tokenUrl).toBe('https://api.citypass-login.pp.ua/oauth/token');
    expect(client.clientId).toBe('grupo5');
  });
});
