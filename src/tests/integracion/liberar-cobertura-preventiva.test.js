const { LiberarCoberturaPreventivaCommand } = require('../../integracion/commands/liberar-cobertura-preventiva');

describe('LiberarCoberturaPreventivaCommand', () => {
  it('rechaza construccion sin causationEventId', () => {
    expect(() => new LiberarCoberturaPreventivaCommand({})).toThrow(/causationEventId/);
  });

  it('execute sin client lanza', async () => {
    const cmd = new LiberarCoberturaPreventivaCommand({ causationEventId: 'e' });
    await expect(cmd.execute({})).rejects.toThrow(/ctx.client/);
  });

  it('cancela emergencias PENDING EXTERNAL con correlation_id = causationEventId', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'em-1' }, { id: 'em-2' }] }),
    };
    const cmd = new LiberarCoberturaPreventivaCommand({ causationEventId: 'evt-123' });
    const result = await cmd.execute({ client });

    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE emergencies/);
    expect(sql).toMatch(/status = 'CANCELLED'/);
    expect(sql).toMatch(/source = 'EXTERNAL'/);
    expect(sql).toMatch(/status = 'PENDING'/);
    expect(params).toEqual(['evt-123']);
    expect(result).toEqual({ cancelledCount: 2, cancelledIds: ['em-1', 'em-2'] });
  });

  it('devuelve cancelledCount=0 si no afecto filas (no-op)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const cmd = new LiberarCoberturaPreventivaCommand({ causationEventId: 'evt-ninguno' });
    const result = await cmd.execute({ client });
    expect(result).toEqual({ cancelledCount: 0, cancelledIds: [] });
  });
});
