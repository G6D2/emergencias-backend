const request = require('supertest');
const { createApp } = require('../app');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

function stubAuthenticate(user) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

const DISPATCHER = { sub: 'DISP-001', groups: ['dispatcher'] };
const VALID_UUID = '11111111-1111-4111-8111-111111111111';

// Hallazgo de auditoría A2: un 5xx no debe devolver err.message crudo (podría
// ser, p. ej., el mensaje de un error de Postgres con detalles de esquema).
describe('app error middleware (5xx sanitization)', () => {
  it('hides the raw error message on a 500 and logs the detail instead', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Sin comillas: el log serializa el meta con JSON.stringify y escaparía
    // comillas internas, lo que rompería una búsqueda de substring literal.
    const rawMessage = 'relation emergencias_x does not exist (Postgres detail leak)';

    const repository = {
      findDetailById: async () => {
        throw new Error(rawMessage);
      },
    };

    const app = createApp(mockKafkaService, repository, {
      authenticate: stubAuthenticate(DISPATCHER),
    });

    const response = await request(app)
      .get(`/api/emergencies/${VALID_UUID}`)
      .expect(500);

    expect(response.body).toEqual({
      error: 'InternalServerError',
      message: 'Error interno',
    });
    expect(response.text).not.toContain(rawMessage);

    // El detalle real solo va al log (secureLog usa console.error para nivel 'error').
    expect(errorSpy).toHaveBeenCalled();
    const loggedCall = errorSpy.mock.calls.find((call) => call[0].includes(rawMessage));
    expect(loggedCall).toBeDefined();

    errorSpy.mockRestore();
  });

  it('leaves typed 4xx errors untouched (message still reaches the client)', async () => {
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(DISPATCHER),
    });

    const response = await request(app)
      .get('/api/emergencies/not-a-uuid')
      .expect(400);

    expect(response.body).toEqual({
      error: 'ValidationError',
      message: 'Emergency id must be a valid UUID',
    });
  });
});
