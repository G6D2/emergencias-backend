const { createEventoComunitarioPublicadoMapper } = require('../../integracion/mappers/evento-comunitario-publicado');
const { ProgramarCoberturaPreventivaCommand } = require('../../integracion/commands/programar-cobertura-preventiva');

describe('mapper EventoComunitarioPublicado', () => {
  const makeDeps = (umbral = 500) => ({
    umbralCapacidad: umbral,
    locationCrypto: { encryptLocation: jest.fn() },
  });

  it('rechaza factory sin umbralCapacidad numerico', () => {
    expect(() => createEventoComunitarioPublicadoMapper({ locationCrypto: {} }))
      .toThrow(/umbralCapacidad/);
  });

  it('rechaza factory sin locationCrypto', () => {
    expect(() => createEventoComunitarioPublicadoMapper({ umbralCapacidad: 500 }))
      .toThrow(/locationCrypto/);
  });

  it('devuelve [] si capacidad < umbral', () => {
    const mapper = createEventoComunitarioPublicadoMapper(makeDeps(500));
    const cmds = mapper({
      metadata: { eventId: 'e1' },
      data: { nombre: 'Chico', capacidad: 100, latitud: -34.6, longitud: -58.4 },
    });
    expect(cmds).toEqual([]);
  });

  it('devuelve [] si no viene capacidad', () => {
    const mapper = createEventoComunitarioPublicadoMapper(makeDeps(500));
    const cmds = mapper({
      metadata: { eventId: 'e1' },
      data: { nombre: 'X', latitud: 0, longitud: 0 },
    });
    expect(cmds).toEqual([]);
  });

  it('emite ProgramarCobertura si capacidad >= umbral con lat/lng', () => {
    const deps = makeDeps(500);
    const mapper = createEventoComunitarioPublicadoMapper(deps);
    const cmds = mapper({
      metadata: { eventId: 'evt-publicado-1' },
      data: {
        nombre: 'Festival',
        capacidad: 1200,
        latitud: -34.60,
        longitud: -58.40,
      },
    });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(ProgramarCoberturaPreventivaCommand);
    expect(cmds[0].causationEventId).toBe('evt-publicado-1');
    expect(cmds[0].capacidad).toBe(1200);
    expect(cmds[0].latitud).toBe(-34.60);
    expect(cmds[0].longitud).toBe(-58.40);
    expect(cmds[0].requiresManualValidation()).toBe(false);
  });

  it('emite ProgramarCobertura con requires_manual=true si lat/lng null', () => {
    const mapper = createEventoComunitarioPublicadoMapper(makeDeps(500));
    const cmds = mapper({
      metadata: { eventId: 'evt-2' },
      data: {
        nombre: 'Festival legacy',
        capacidad: 1200,
        latitud: null,
        longitud: null,
      },
    });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].requiresManualValidation()).toBe(true);
  });

  it('propaga userIdForExternal al comando', () => {
    const mapper = createEventoComunitarioPublicadoMapper({
      ...makeDeps(500),
      userIdForExternal: 'custom-system',
    });
    const [cmd] = mapper({
      metadata: { eventId: 'e' },
      data: { capacidad: 1000, latitud: 0, longitud: 0 },
    });
    expect(cmd.userIdForExternal).toBe('custom-system');
  });

  it('capacidad igual al umbral es suficiente (>=)', () => {
    const mapper = createEventoComunitarioPublicadoMapper(makeDeps(500));
    const cmds = mapper({
      metadata: { eventId: 'e' },
      data: { capacidad: 500, latitud: 0, longitud: 0 },
    });
    expect(cmds).toHaveLength(1);
  });
});
