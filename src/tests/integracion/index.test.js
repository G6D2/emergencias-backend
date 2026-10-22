const integracion = require('../../integracion');

describe('src/integracion index', () => {
  it('exporta EventBus, MapperRegistry y Listener', () => {
    expect(typeof integracion.EventBus).toBe('function');
    expect(typeof integracion.MapperRegistry).toBe('function');
    expect(typeof integracion.Listener).toBe('function');
  });
});
