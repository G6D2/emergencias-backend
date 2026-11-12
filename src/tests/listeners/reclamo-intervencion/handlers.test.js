jest.mock('../../../security/secure-log', () => ({ secureLog: jest.fn() }));

const {
  CREAR_INTERVENCION,
  createCrearIntervencionHandler,
} = require('../../../listeners/reclamo-intervencion/handlers/crear-intervencion.handler');
const {
  CERRAR_INTERVENCION,
  createCerrarIntervencionHandler,
} = require('../../../listeners/reclamo-intervencion/handlers/cerrar-intervencion.handler');

const client = { query: jest.fn() };

function buildRepository(existing = []) {
  return {
    findByCausa: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockResolvedValue({}),
    updateStatus: jest.fn().mockResolvedValue({}),
  };
}

const PAYLOAD = {
  reclamoId: 'rec-123',
  titulo: 'Auto en la bicisenda',
  prioridad: 'ALTA',
  latitud: -34.6037,
  longitud: -58.3816,
  direccion: 'Av. Corrientes 1234',
  barrio: 'San Nicolás',
  correlationId: '0d9f7f0e-5a52-4f5e-9a55-2f6f0c1f3a10',
};

describe('createCrearIntervencionHandler', () => {
  it('exporta el nombre de tipo y exige el repositorio', () => {
    expect(CREAR_INTERVENCION).toBe('CrearIntervencionPorReclamo');
    expect(() => createCrearIntervencionHandler({})).toThrow(/emergencyRepository/);
  });

  it('crea una emergencia TRANSITO externa con causa RECLAMO', async () => {
    const emergencyRepository = buildRepository();
    const handler = createCrearIntervencionHandler({ emergencyRepository, topic: 'emergencias.boton-panico' });

    const result = await handler(client, PAYLOAD);

    expect(result.created).toBe(true);
    expect(emergencyRepository.findByCausa).toHaveBeenCalledWith(client, { causaTipo: 'RECLAMO', causaId: 'rec-123' });
    const input = emergencyRepository.create.mock.calls[0][0];
    expect(input).toMatchObject({
      client,
      id: result.emergencyId,
      correlationId: PAYLOAD.correlationId,
      userId: null,
      latitude: -34.6037,
      longitude: -58.3816,
      address: 'Av. Corrientes 1234',
      barrioText: 'San Nicolás',
      description: 'Reclamo por ciclovía obstruida — Auto en la bicisenda',
      severity: 'high',
      emergencyType: 'TRANSITO',
      status: 'PENDING',
      source: 'EXTERNAL',
      requiresManualValidation: false,
      causaTipo: 'RECLAMO',
      causaId: 'rec-123',
    });
    expect(input.outboxEvent.topic).toBe('emergencias.boton-panico');
  });

  it('publica EmergenciaCreada con la causa, afectaCirculacion y sin ciudadano', async () => {
    const emergencyRepository = buildRepository();
    const handler = createCrearIntervencionHandler({ emergencyRepository });
    await handler(client, PAYLOAD);
    const input = emergencyRepository.create.mock.calls[0][0];

    const event = input.outboxEvent.payload(
      { ...input, barrio: 'SAN NICOLAS', createdAt: '2026-11-12T15:00:00.000Z' },
      'evt-1'
    );

    expect(event.type).toBe('EmergenciaCreada');
    expect(event.data).toMatchObject({
      categoria: 'TRANSITO',
      prioridad: 'ALTA',
      estado: 'PENDIENTE',
      barrio: 'SAN NICOLAS',
      latitud: -34.604,
      longitud: -58.382,
      afectaCirculacion: true,
      causaTipo: 'RECLAMO',
      causaId: 'rec-123',
      ciudadanoId: null,
    });
  });

  it('no crea otra si el reclamo ya tiene intervención', async () => {
    const emergencyRepository = buildRepository([{ id: 'em-1', status: 'DISPATCHED' }]);
    const handler = createCrearIntervencionHandler({ emergencyRepository });

    await expect(handler(client, PAYLOAD)).resolves.toEqual({ emergencyId: 'em-1', created: false });
    expect(emergencyRepository.create).not.toHaveBeenCalled();
  });

  it('sin coordenadas queda para validación manual', async () => {
    const emergencyRepository = buildRepository();
    const handler = createCrearIntervencionHandler({ emergencyRepository });
    await handler(client, { ...PAYLOAD, latitud: null, longitud: null });

    expect(emergencyRepository.create.mock.calls[0][0]).toMatchObject({
      latitude: null, longitude: null, requiresManualValidation: true,
    });
  });

  it('prioridad desconocida o ausente cae a la del tipo; correlationId no UUID usa el id propio', async () => {
    const emergencyRepository = buildRepository();
    const handler = createCrearIntervencionHandler({ emergencyRepository });
    const result = await handler(client, { ...PAYLOAD, prioridad: 'URGENTISIMA', correlationId: 'req-7c9e6679', titulo: null });

    expect(emergencyRepository.create.mock.calls[0][0]).toMatchObject({
      severity: 'medium',
      correlationId: result.emergencyId,
      description: 'Reclamo por ciclovía obstruida',
    });
  });

  it('recorta la descripción a 200 caracteres y falla sin reclamoId', async () => {
    const emergencyRepository = buildRepository();
    const handler = createCrearIntervencionHandler({ emergencyRepository });
    await handler(client, { ...PAYLOAD, titulo: 'x'.repeat(500) });
    expect(emergencyRepository.create.mock.calls[0][0].description).toHaveLength(200);

    await expect(handler(client, {})).rejects.toThrow(/reclamoId/);
    await expect(handler(client, undefined)).rejects.toThrow(/reclamoId/);
  });
});

describe('createCerrarIntervencionHandler', () => {
  it('exporta el nombre de tipo y exige el repositorio', () => {
    expect(CERRAR_INTERVENCION).toBe('CerrarIntervencionPorReclamo');
    expect(() => createCerrarIntervencionHandler({})).toThrow(/emergencyRepository/);
  });

  it('cancela las intervenciones que no salieron y deja las demás', async () => {
    const emergencyRepository = buildRepository([
      { id: 'em-1', status: 'PENDING' },
      { id: 'em-2', status: 'VALIDATED' },
      { id: 'em-3', status: 'DISPATCHED' },
      { id: 'em-4', status: 'CLOSED' },
    ]);
    const handler = createCerrarIntervencionHandler({ emergencyRepository, topic: 'emergencias.estado-actualizado' });

    await expect(handler(client, { reclamoId: 'rec-123', estado: 'RESUELTO' })).resolves.toEqual({ cancelled: 2 });

    expect(emergencyRepository.findByCausa).toHaveBeenCalledWith(client, { causaTipo: 'RECLAMO', causaId: 'rec-123' });
    expect(emergencyRepository.updateStatus).toHaveBeenCalledTimes(2);
    const [id, input] = emergencyRepository.updateStatus.mock.calls[0];
    expect(id).toBe('em-1');
    expect(input).toMatchObject({ client, newStatus: 'CANCELLED', actor: 'eda:reclamos', reason: 'Reclamo RESUELTO' });
    expect(input.outboxEvent.topic).toBe('emergencias.estado-actualizado');

    const event = input.outboxEvent.payload(
      {
        emergency: { id: 'em-1', severity: 'high', updatedAt: '2026-11-12T15:10:00.000Z' },
        history: { previousStatus: 'PENDING', newStatus: 'CANCELLED' },
      },
      'evt-2'
    );
    expect(event.type).toBe('EmergenciaActualizada');
    expect(event.data).toMatchObject({
      emergenciaId: 'em-1',
      estadoAnterior: 'PENDIENTE',
      estadoNuevo: 'CANCELADA',
      usuarioId: 'eda:reclamos',
      resolucion: 'Reclamo RESUELTO',
    });
  });

  it('un reclamo sin intervención no hace nada', async () => {
    const emergencyRepository = buildRepository([]);
    const handler = createCerrarIntervencionHandler({ emergencyRepository });

    await expect(handler(client, { reclamoId: 'rec-otro', estado: 'CERRADO' })).resolves.toEqual({ cancelled: 0 });
    expect(emergencyRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('falla sin reclamoId', async () => {
    const handler = createCerrarIntervencionHandler({ emergencyRepository: buildRepository() });
    await expect(handler(client, {})).rejects.toThrow(/reclamoId/);
  });
});
