// El spec de OpenAPI sale del JSDoc (@openapi) de app.js y routes/. Si el YAML
// de un bloque no parsea, swagger-jsdoc no falla: avisa por consola y deja
// afuera TODOS los paths de ese archivo. Este test corta ese caso.
describe('spec de OpenAPI (swagger-jsdoc)', () => {
  let spec;
  let infoSpy;
  let errorSpy;

  beforeAll(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.isolateModules(() => {
      ({ swaggerSpec: spec } = require('../swagger'));
    });
  });

  afterAll(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('todas las anotaciones @openapi parsean: swagger-jsdoc no reporta errores', () => {
    const reported = [...infoSpy.mock.calls, ...errorSpy.mock.calls].map((args) => String(args[0]));
    expect(reported).toEqual([]);
  });

  it('GET /api/officers documenta el filtro status y su 400', () => {
    const operation = spec.paths['/api/officers'].get;
    const status = operation.parameters.find((parameter) => parameter.name === 'status');

    expect(status.schema.enum).toEqual(['disponible', 'ocupado']);
    expect(operation.responses).toHaveProperty('400');
  });

  it('GET /api/emergencies documenta priority como alias de severity', () => {
    const { parameters, responses } = spec.paths['/api/emergencies'].get;
    const byName = Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter]));

    expect(byName.priority.schema.enum).toEqual(byName.severity.schema.enum);
    expect(responses['400'].description).toMatch(/priority/);
  });
});
