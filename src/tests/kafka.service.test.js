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

const { KafkaService } = require('../services/kafka.service');
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
