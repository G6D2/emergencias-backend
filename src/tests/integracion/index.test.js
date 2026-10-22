const integracion = require('../../integracion');

describe('src/integracion index', () => {
  it('exporta las piezas publicas del paquete', () => {
    expect(typeof integracion.EventBus).toBe('function');
    expect(typeof integracion.MapperRegistry).toBe('function');
    expect(typeof integracion.Listener).toBe('function');
    expect(typeof integracion.EdaAuthClient).toBe('function');
    expect(typeof integracion.defaultConsumerKafkaFactory).toBe('function');
  });
});
