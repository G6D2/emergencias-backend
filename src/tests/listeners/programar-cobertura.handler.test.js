const {
  createProgramarCoberturaHandler: crearHandler,
  PROGRAMAR_COBERTURA,
} = require('../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { setBusLocationCryptoForTests } = require('../../security/bus-location-crypto');

function buildRepository(existing = []) {
  return {
    findByCausa: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockImplementation(async (input) => ({ ...input, createdAt: '2026-11-05T12:00:00.000Z' })),
  };
}

// La marca de baja de un evento cancelado vive en contexto_zona (#88).
function buildContextoZona({ cancelado = false } = {}) {
  return {
    bloquearGrupo: jest.fn().mockResolvedValue(undefined),
    grupoDadoDeBaja: jest.fn().mockResolvedValue(cancelado),
  };
}

// Por default, un evento sin marca de baja; los tests del #88 pasan la suya.
function createProgramarCoberturaHandler(deps) {
  return crearHandler({ contextoZonaRepository: buildContextoZona(), ...deps });
}

const client = { query: jest.fn() };

const payload = {
  eventoId: 'ev-77',
  titulo: 'Carnaval de San Telmo',
  latitud: -34.615,
  longitud: -58.371,
  direccion: 'Defensa 1000',
  capacidad: 2000,
  correlationId: 'evento-ev-77',
};

describe('PROGRAMAR_COBERTURA', () => {
  it('exporta el nombre de tipo', () => {
    expect(PROGRAMAR_COBERTURA).toBe('ProgramarCobertura');
  });
});

describe('createProgramarCoberturaHandler', () => {
  beforeEach(() => {
    setBusLocationCryptoForTests(null);
  });

  afterEach(() => {
    setBusLocationCryptoForTests(undefined);
  });

  it('falla sin emergencyRepository o sin contextoZonaRepository', () => {
    expect(() => crearHandler({})).toThrow(/emergencyRepository/);
    expect(() => crearHandler({ emergencyRepository: buildRepository() })).toThrow(/contextoZonaRepository/);
  });

  it('toma el lock del evento y, sin marca de baja, sigue con el alta', async () => {
    const emergencyRepository = buildRepository();
    const contextoZonaRepository = buildContextoZona();
    const handler = createProgramarCoberturaHandler({ emergencyRepository, contextoZonaRepository });

    await handler(client, payload);

    const evento = { tipo: 'EVENTO_ESPACIO_PUBLICO', origen: 'espacios', referenciaBase: 'ev-77' };
    expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalledWith(client, evento);
    expect(contextoZonaRepository.grupoDadoDeBaja).toHaveBeenCalledWith(client, evento);
    const [lock] = contextoZonaRepository.bloquearGrupo.mock.invocationCallOrder;
    const [marca] = contextoZonaRepository.grupoDadoDeBaja.mock.invocationCallOrder;
    const [busqueda] = emergencyRepository.findByCausa.mock.invocationCallOrder;
    expect(lock).toBeLessThan(marca);
    expect(marca).toBeLessThan(busqueda);
    expect(emergencyRepository.create).toHaveBeenCalledTimes(1);
  });

  it('un evento ya cancelado (la cancelación llegó antes) no programa cobertura (#88)', async () => {
    const emergencyRepository = buildRepository();
    const contextoZonaRepository = buildContextoZona({ cancelado: true });
    const handler = createProgramarCoberturaHandler({ emergencyRepository, contextoZonaRepository });

    await expect(handler(client, payload)).resolves.toEqual({ emergencyId: null, created: false, cancelado: true });
    expect(emergencyRepository.findByCausa).not.toHaveBeenCalled();
    expect(emergencyRepository.create).not.toHaveBeenCalled();
  });

  it('una RESERVA no toma el lock ni mira la marca de baja: no tiene cancelación', async () => {
    const emergencyRepository = buildRepository();
    const contextoZonaRepository = buildContextoZona({ cancelado: true });
    const handler = createProgramarCoberturaHandler({ emergencyRepository, contextoZonaRepository });

    await handler(client, { ...payload, eventoId: 'res-9', causaTipo: 'RESERVA' });

    expect(contextoZonaRepository.bloquearGrupo).not.toHaveBeenCalled();
    expect(contextoZonaRepository.grupoDadoDeBaja).not.toHaveBeenCalled();
    expect(emergencyRepository.create).toHaveBeenCalledTimes(1);
  });

  it('crea la emergencia PREVENTIVA por el repositorio, en la transacción del caller', async () => {
    const emergencyRepository = buildRepository();
    const handler = createProgramarCoberturaHandler({ emergencyRepository, topic: 'emergencias.boton-panico' });

    const result = await handler(client, payload);

    expect(emergencyRepository.findByCausa).toHaveBeenCalledWith(client, {
      causaTipo: 'EVENTO_PUBLICO',
      causaId: 'ev-77',
      emergencyType: 'PREVENTIVA',
    });
    const input = emergencyRepository.create.mock.calls[0][0];
    expect(input).toMatchObject({
      client,
      userId: null,
      latitude: -34.615,
      longitude: -58.371,
      address: 'Defensa 1000',
      severity: 'low',
      emergencyType: 'PREVENTIVA',
      status: 'PENDING',
      source: 'EXTERNAL',
      requiresManualValidation: false,
      causaTipo: 'EVENTO_PUBLICO',
      causaId: 'ev-77',
    });
    expect(input.description).toBe('Cobertura preventiva — Carnaval de San Telmo (2000 asistentes esperados)');
    expect(input.outboxEvent.topic).toBe('emergencias.boton-panico');
    expect(result).toEqual({ emergencyId: input.id, created: true });
  });

  it('el outbox lleva EmergenciaCreada con la causa, barrio y sin ciudadano', async () => {
    const emergencyRepository = buildRepository();
    const handler = createProgramarCoberturaHandler({ emergencyRepository });
    await handler(client, payload);

    const input = emergencyRepository.create.mock.calls[0][0];
    expect(input).toMatchObject({
      latitude: -34.615,
      longitude: -58.371,
      barrioText: null,
    });

    const event = input.outboxEvent.payload(
      {
        ...input,
        emergencyType: 'PREVENTIVA',
        barrio: 'SAN TELMO',
        latitude: -34.615,
        longitude: -58.371,
        createdAt: '2026-11-05T12:00:00.000Z',
      },
      'evt-1'
    );
    expect(event.type).toBe('EmergenciaCreada');
    expect(event.data).toMatchObject({
      categoria: 'PREVENTIVA',
      prioridad: 'BAJA',
      estado: 'PENDIENTE',
      causaTipo: 'EVENTO_PUBLICO',
      causaId: 'ev-77',
      ciudadanoId: null,
    });
    expect(event.data.barrio).toBe('SAN TELMO');
    expect(event.data.latitud).toBe(-34.615);
    expect(event.data.longitud).toBe(-58.371);
    expect(event.data.ubicacion).toEqual({
      barrio: 'SAN TELMO',
      latitud: null,
      longitud: null,
    });
  });

  it('pasa barrioText del evento al create para fallback sin coords', async () => {
    const emergencyRepository = buildRepository();
    const handler = createProgramarCoberturaHandler({ emergencyRepository });
    await handler(client, {
      ...payload,
      latitud: null,
      longitud: null,
      barrio: 'Almagro',
    });

    expect(emergencyRepository.create.mock.calls[0][0]).toMatchObject({
      latitude: null,
      longitude: null,
      barrioText: 'Almagro',
      requiresManualValidation: true,
    });
  });

  it('usa el correlationId del evento solo si es un UUID', async () => {
    const emergencyRepository = buildRepository();
    const handler = createProgramarCoberturaHandler({ emergencyRepository });

    await handler(client, payload);
    const conTextoLibre = emergencyRepository.create.mock.calls[0][0];
    expect(conTextoLibre.correlationId).toBe(conTextoLibre.id);

    const uuid = '6f1c9a4e-3c2b-4a5d-9e11-2b7d5c8a1f30';
    await handler(client, { ...payload, correlationId: uuid });
    expect(emergencyRepository.create.mock.calls[1][0].correlationId).toBe(uuid);
  });

  it('sin coordenadas queda para validación manual', async () => {
    const emergencyRepository = buildRepository();
    const handler = createProgramarCoberturaHandler({ emergencyRepository });
    await handler(client, { ...payload, latitud: null, longitud: null });

    expect(emergencyRepository.create.mock.calls[0][0]).toMatchObject({
      latitude: null,
      longitude: null,
      requiresManualValidation: true,
    });
  });

  it('no duplica la cobertura si el evento se republica', async () => {
    const emergencyRepository = buildRepository([{ id: 'em-1', status: 'PENDING' }]);
    const handler = createProgramarCoberturaHandler({ emergencyRepository });

    await expect(handler(client, payload)).resolves.toEqual({ emergencyId: 'em-1', created: false });
    expect(emergencyRepository.create).not.toHaveBeenCalled();
  });

  it('con causaTipo RESERVA deduplica y crea la cobertura con esa causa', async () => {
    const emergencyRepository = buildRepository();
    const handler = createProgramarCoberturaHandler({ emergencyRepository });

    await handler(client, { ...payload, eventoId: 'res-9', causaTipo: 'RESERVA', titulo: 'Reserva de espacio (PLAZA)' });

    expect(emergencyRepository.findByCausa).toHaveBeenCalledWith(client, {
      causaTipo: 'RESERVA',
      causaId: 'res-9',
      emergencyType: 'PREVENTIVA',
    });
    const input = emergencyRepository.create.mock.calls[0][0];
    expect(input).toMatchObject({ causaTipo: 'RESERVA', causaId: 'res-9', emergencyType: 'PREVENTIVA' });
    expect(input.description).toBe('Cobertura preventiva — Reserva de espacio (PLAZA) (2000 asistentes esperados)');

    const event = input.outboxEvent.payload({ ...input, createdAt: '2026-11-16T12:00:00.000Z' }, 'evt-9');
    expect(event.data).toMatchObject({ causaTipo: 'RESERVA', causaId: 'res-9', categoria: 'PREVENTIVA' });
  });

  it('rechaza un causaTipo que no es de cobertura preventiva', async () => {
    const emergencyRepository = buildRepository();
    const handler = createProgramarCoberturaHandler({ emergencyRepository });
    await expect(handler(client, { ...payload, causaTipo: 'RECLAMO' })).rejects.toThrow(/causaTipo RECLAMO/);
    expect(emergencyRepository.findByCausa).not.toHaveBeenCalled();
  });

  it('falla sin eventoId', async () => {
    const handler = createProgramarCoberturaHandler({ emergencyRepository: buildRepository() });
    await expect(handler(client, { ...payload, eventoId: undefined })).rejects.toThrow(/eventoId/);
  });
});
