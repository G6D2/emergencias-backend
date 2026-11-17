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
      message: 'El id de la emergencia tiene que ser un UUID válido',
    });
  });
});

// Ruta o método no soportado: 404 en JSON con el shape { error, message },
// no el 404 HTML por defecto de Express (hallazgo de la regresión 23/09).
describe('unknown route/method 404 (JSON, not HTML)', () => {
  it('devuelve 404 JSON para una ruta inexistente', async () => {
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(DISPATCHER),
    });

    const response = await request(app)
      .get('/api/ruta-que-no-existe')
      .expect(404)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      error: 'NotFoundError',
      message: 'No existe la ruta GET /api/ruta-que-no-existe',
    });
  });

  it('devuelve 404 JSON para un método no soportado sobre una ruta conocida', async () => {
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(DISPATCHER),
    });

    const response = await request(app)
      .delete('/health')
      .expect(404)
      .expect('Content-Type', /json/);

    expect(response.body.error).toBe('NotFoundError');
  });
});

// express.json() rechaza el cuerpo con un texto en inglés de la librería (o
// de JSON.parse, que además cita un pedazo del cuerpo): se responde en
// castellano y el `error` queda como lo arma la librería.
describe('cuerpo rechazado por express.json()', () => {
  function buildApp() {
    return createApp(mockKafkaService, {}, { authenticate: stubAuthenticate(DISPATCHER) });
  }

  it('JSON mal formado: 400 en castellano, sin repetir el cuerpo', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await request(buildApp())
      .post('/api/panic-button')
      .set('Content-Type', 'application/json')
      .send('{"location": secreto')
      .expect(400);

    expect(response.body).toEqual({
      error: 'SyntaxError',
      message: 'El cuerpo del pedido no es un JSON válido',
    });
    expect(response.text).not.toContain('secreto');
    warnSpy.mockRestore();
  });

  it('cuerpo más grande que el límite: 413 en castellano', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await request(buildApp())
      .post('/api/panic-button')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ description: 'x'.repeat(40 * 1024) }))
      .expect(413);

    expect(response.body).toEqual({
      error: 'PayloadTooLargeError',
      message: 'El cuerpo del pedido es demasiado grande',
    });
    warnSpy.mockRestore();
  });

  it('Content-Encoding desconocido: 415 en castellano', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await request(buildApp())
      .post('/api/panic-button')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'inventado')
      .send('{}')
      .expect(415);

    expect(response.body).toEqual({
      error: 'UnsupportedMediaTypeError',
      message: 'Content-Encoding no soportado',
    });
    warnSpy.mockRestore();
  });
});
