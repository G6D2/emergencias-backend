const { MapperRegistry } = require('../../integracion/mapper-registry');

describe('MapperRegistry', () => {
  it('lookup devuelve null para claves no registradas', () => {
    const registry = new MapperRegistry();
    expect(registry.lookup('NoRegistrado')).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it('register + lookup devuelve el mapper registrado', () => {
    const registry = new MapperRegistry();
    const mapper = jest.fn();
    registry.register('EventoComunitarioPublicado', mapper);
    expect(registry.lookup('EventoComunitarioPublicado')).toBe(mapper);
    expect(registry.size()).toBe(1);
  });

  it('register valida eventTypeShortName (string no vacio)', () => {
    const registry = new MapperRegistry();
    expect(() => registry.register('', jest.fn())).toThrow(/eventTypeShortName/);
    expect(() => registry.register(null, jest.fn())).toThrow(/eventTypeShortName/);
    expect(() => registry.register(123, jest.fn())).toThrow(/eventTypeShortName/);
  });

  it('register valida mapperFn (function)', () => {
    const registry = new MapperRegistry();
    expect(() => registry.register('X', null)).toThrow(/mapperFn/);
    expect(() => registry.register('X', 'no-funcion')).toThrow(/mapperFn/);
  });

  it('register rechaza duplicados', () => {
    const registry = new MapperRegistry();
    registry.register('X', jest.fn());
    expect(() => registry.register('X', jest.fn())).toThrow(/ya registrado/);
  });

  it('shortNameFromTopic extrae el ultimo segmento del FQN', () => {
    expect(MapperRegistry.shortNameFromTopic('com.citypass.turismo.EventoComunitarioPublicado'))
      .toBe('EventoComunitarioPublicado');
  });

  it('shortNameFromTopic devuelve el topic si no tiene puntos', () => {
    expect(MapperRegistry.shortNameFromTopic('SinNamespace')).toBe('SinNamespace');
  });

  it('shortNameFromTopic devuelve null si no es string', () => {
    expect(MapperRegistry.shortNameFromTopic(null)).toBeNull();
    expect(MapperRegistry.shortNameFromTopic(123)).toBeNull();
  });
});
