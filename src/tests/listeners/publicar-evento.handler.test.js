const { createPublicarEventoHandler } = require('../../listeners/handlers/publicar-evento.handler');

describe('handler PublicarEvento', () => {
  const client = { query: jest.fn() };
  const context = { metadata: { eventId: 'evento-externo-1' }, data: {} };

  function build() {
    const emergencyRepository = { insertOutboxEvent: jest.fn().mockResolvedValue(undefined) };
    return { emergencyRepository, handler: createPublicarEventoHandler(emergencyRepository) };
  }

  it('deja el evento en el outbox con el client de la transaccion y el causationId', async () => {
    const { emergencyRepository, handler } = build();
    const event = { type: 'EventoEjemplo', correlationId: 'c1', data: { id: 1 } };

    await handler(client, { topic: 'emergencias.ejemplo', event }, context);

    expect(emergencyRepository.insertOutboxEvent).toHaveBeenCalledWith(client, {
      topic: 'emergencias.ejemplo',
      payload: { ...event, causationId: 'evento-externo-1' },
    });
  });

  it('sin eventId en la metadata el causationId queda en null', async () => {
    const { emergencyRepository, handler } = build();

    await handler(client, { topic: 't', event: { type: 'E' } }, {});

    expect(emergencyRepository.insertOutboxEvent.mock.calls[0][1].payload.causationId).toBeNull();
  });

  it.each([
    ['sin payload', undefined, /requiere topic/],
    ['sin topic', { event: { type: 'E' } }, /requiere topic/],
    ['sin event', { topic: 't' }, /requiere event con type/],
    ['con event sin type', { topic: 't', event: {} }, /requiere event con type/],
  ])('falla %s y no escribe', async (_nombre, payload, error) => {
    const { emergencyRepository, handler } = build();

    await expect(handler(client, payload, context)).rejects.toThrow(error);

    expect(emergencyRepository.insertOutboxEvent).not.toHaveBeenCalled();
  });
});
