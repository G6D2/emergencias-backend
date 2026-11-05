const {
  createCancelarCoberturaHandler,
  CANCELAR_COBERTURA,
} = require('../../listeners/cobertura-preventiva/handlers/cancelar-cobertura.handler');

function buildRepository(coberturas) {
  return {
    findByCausa: jest.fn().mockResolvedValue(coberturas),
    updateStatus: jest.fn().mockResolvedValue({}),
  };
}

const client = { query: jest.fn() };

describe('createCancelarCoberturaHandler', () => {
  it('exporta el nombre de tipo', () => {
    expect(CANCELAR_COBERTURA).toBe('CancelarCobertura');
  });

  it('falla sin emergencyRepository', () => {
    expect(() => createCancelarCoberturaHandler({})).toThrow(/emergencyRepository/);
  });

  it('cancela por el repositorio las coberturas que siguen PENDING o VALIDATED', async () => {
    const emergencyRepository = buildRepository([
      { id: 'em-1', status: 'PENDING' },
      { id: 'em-2', status: 'VALIDATED' },
      { id: 'em-3', status: 'DISPATCHED' },
    ]);
    const handler = createCancelarCoberturaHandler({ emergencyRepository, topic: 'emergencias.estado-actualizado' });

    await expect(handler(client, { eventoId: 'ev-77' })).resolves.toEqual({ cancelled: 2 });

    expect(emergencyRepository.findByCausa).toHaveBeenCalledWith(client, {
      causaTipo: 'EVENTO_PUBLICO',
      causaId: 'ev-77',
      emergencyType: 'PREVENTIVA',
    });
    expect(emergencyRepository.updateStatus).toHaveBeenCalledTimes(2);
    const [id, input] = emergencyRepository.updateStatus.mock.calls[0];
    expect(id).toBe('em-1');
    expect(input).toMatchObject({
      client,
      newStatus: 'CANCELLED',
      actor: 'eda:espacios',
      reason: 'Evento comunitario cancelado',
    });
    expect(input.outboxEvent.topic).toBe('emergencias.estado-actualizado');
  });

  it('el outbox lleva EmergenciaActualizada en CANCELADA', async () => {
    const emergencyRepository = buildRepository([{ id: 'em-1', status: 'PENDING' }]);
    const handler = createCancelarCoberturaHandler({ emergencyRepository });
    await handler(client, { eventoId: 'ev-77' });

    const { outboxEvent } = emergencyRepository.updateStatus.mock.calls[0][1];
    const event = outboxEvent.payload({
      emergency: { id: 'em-1', severity: 'low', updatedAt: '2026-11-05T12:00:00.000Z' },
      history: { previousStatus: 'PENDING', newStatus: 'CANCELLED' },
    }, 'evt-9');
    expect(event.type).toBe('EmergenciaActualizada');
    expect(event.data).toMatchObject({ emergenciaId: 'em-1', estadoAnterior: 'PENDIENTE', estadoNuevo: 'CANCELADA' });
  });

  it('sin cobertura no hace nada', async () => {
    const emergencyRepository = buildRepository([]);
    const handler = createCancelarCoberturaHandler({ emergencyRepository });
    await expect(handler(client, { eventoId: 'ev-x' })).resolves.toEqual({ cancelled: 0 });
    expect(emergencyRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('falla sin eventoId', async () => {
    const handler = createCancelarCoberturaHandler({ emergencyRepository: buildRepository([]) });
    await expect(handler(client, {})).rejects.toThrow(/eventoId/);
  });
});
