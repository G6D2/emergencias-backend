const {
  createProgramarCoberturaHandler,
  PROGRAMAR_COBERTURA,
} = require('../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { setBusLocationCryptoForTests } = require('../../security/bus-location-crypto');

function buildRepository(existing = []) {
  return {
    findByCausa: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockImplementation(async (input) => ({ ...input, createdAt: '2026-11-05T12:00:00.000Z' })),
  };
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

  it('falla sin emergencyRepository', () => {
    expect(() => createProgramarCoberturaHandler({})).toThrow(/emergencyRepository/);
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
    expect(event.data.latitud).toBeUndefined();
    expect(event.data.longitud).toBeUndefined();
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

  it('falla sin eventoId', async () => {
    const handler = createProgramarCoberturaHandler({ emergencyRepository: buildRepository() });
    await expect(handler(client, { ...payload, eventoId: undefined })).rejects.toThrow(/eventoId/);
  });
});
