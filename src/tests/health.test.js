const request = require('supertest');
const { createApp } = require('../app');

function stubAuthenticate() {
  return (req, res, next) => next();
}

describe('GET /health (estado en memoria)', () => {
  it('devuelve status, kafka, outbox y listeners con lo que arma index.js, sin authMode', async () => {
    const listeners = [{
      name: 'EventoCanceladoListener',
      running: true,
      status: 'running',
      lastPollAt: '2026-11-05T12:00:00.000Z',
      nextRetryAt: null,
    }];
    const health = jest.fn(() => ({
      kafka: 'connected',
      outbox: { enabled: false, lastPollAt: null, producerConnected: false },
      listeners,
    }));
    const app = createApp({ isEnabled: () => true }, {}, { authenticate: stubAuthenticate(), health });

    const response = await request(app).get('/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      kafka: 'connected',
      outbox: { enabled: false, lastPollAt: null, producerConnected: false },
      listeners,
    });
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('no conecta nada contra el broker para responder', async () => {
    const kafkaService = {
      isEnabled: () => true,
      isConnected: () => true,
      connect: jest.fn(),
      checkHealth: jest.fn(),
    };
    const app = createApp(kafkaService, {}, { authenticate: stubAuthenticate() });

    await request(app).get('/health').expect(200);

    expect(kafkaService.connect).not.toHaveBeenCalled();
    expect(kafkaService.checkHealth).not.toHaveBeenCalled();
  });

  it('con KAFKA_ENABLED=false reporta disabled', async () => {
    const app = createApp({ isEnabled: () => false, isConnected: () => false }, {}, {
      authenticate: stubAuthenticate(),
    });

    const response = await request(app).get('/health').expect(200);

    expect(response.body.kafka).toBe('disabled');
  });

  it('no manda el header X-Powered-By', async () => {
    const app = createApp({ isEnabled: () => false }, {}, { authenticate: stubAuthenticate() });

    const health = await request(app).get('/health').expect(200);
    const notFound = await request(app).get('/no-existe').expect(404);

    expect(health.headers).not.toHaveProperty('x-powered-by');
    expect(notFound.headers).not.toHaveProperty('x-powered-by');
  });
});
