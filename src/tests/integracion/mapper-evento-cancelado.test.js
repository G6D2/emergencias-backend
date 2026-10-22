const { createEventoCanceladoMapper } = require('../../integracion/mappers/evento-cancelado');
const { LiberarCoberturaPreventivaCommand } = require('../../integracion/commands/liberar-cobertura-preventiva');

describe('mapper EventoCancelado', () => {
  const mapper = createEventoCanceladoMapper();

  it('emite LiberarCobertura con eventoOriginalId si viene en data', () => {
    const cmds = mapper({
      metadata: { eventId: 'cancel-1' },
      data: { eventoOriginalId: 'publicado-123' },
    });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(LiberarCoberturaPreventivaCommand);
    expect(cmds[0].causationEventId).toBe('publicado-123');
  });

  it('acepta data.eventoPublicadoId como alias', () => {
    const [cmd] = mapper({
      metadata: { eventId: 'cancel-1' },
      data: { eventoPublicadoId: 'publicado-999' },
    });
    expect(cmd.causationEventId).toBe('publicado-999');
  });

  it('acepta data.causationEventId como alias', () => {
    const [cmd] = mapper({
      metadata: { eventId: 'cancel-1' },
      data: { causationEventId: 'publicado-x' },
    });
    expect(cmd.causationEventId).toBe('publicado-x');
  });

  it('cae a metadata.causationId si data no lo trae', () => {
    const [cmd] = mapper({
      metadata: { eventId: 'cancel-1', causationId: 'parent-abc' },
      data: {},
    });
    expect(cmd.causationEventId).toBe('parent-abc');
  });

  it('devuelve [] si no hay forma de identificar el evento origen', () => {
    const cmds = mapper({
      metadata: { eventId: 'cancel-1' },
      data: {},
    });
    expect(cmds).toEqual([]);
  });
});
