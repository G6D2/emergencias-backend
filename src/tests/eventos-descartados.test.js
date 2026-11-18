const { parseDiscardedArgs, resolveDiscardedEvents, USAGE, DEFAULT_LIMIT } = require('../services/eventos-descartados');

const ID_1 = '3f1c2b9e-5d8a-4c7b-9e2f-1a2b3c4d5e6f';
const ID_2 = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';

describe('parseDiscardedArgs', () => {
  it('sin argumentos solo lista, con el tope por default', () => {
    expect(parseDiscardedArgs([])).toEqual({ ids: [], limit: DEFAULT_LIMIT, apply: false, help: false });
  });

  it('lee varios --id, --limit, --apply y --help', () => {
    expect(parseDiscardedArgs(['--id', ID_1, '--limit', '10', '--id', ID_2, '--apply'])).toEqual({
      ids: [ID_1, ID_2], limit: 10, apply: true, help: false,
    });
    expect(parseDiscardedArgs(['-h']).help).toBe(true);
    expect(parseDiscardedArgs(['--help', '--apply']).help).toBe(true);
  });

  it.each([
    [['--apply'], /--apply necesita al menos un --id/],
    [['--id'], /--id necesita un UUID \(vino nada\)/],
    [['--id', 'no-es-uuid'], /--id necesita un UUID \(vino "no-es-uuid"\)/],
    [['--limit'], /--limit necesita un entero mayor que 0 \(vino nada\)/],
    [['--limit', '0'], /--limit necesita un entero mayor que 0 \(vino "0"\)/],
    [['--todo'], /Argumento desconocido: --todo/],
  ])('rechaza %p', (argv, message) => {
    expect(() => parseDiscardedArgs(argv)).toThrow(message);
  });

  it('el uso explica que sin --apply no cambia nada', () => {
    expect(USAGE).toMatch(/sin --apply\s+lista/);
  });
});

describe('resolveDiscardedEvents', () => {
  function createPool(rows = [{ event_id: ID_1 }]) {
    return { query: jest.fn(async () => ({ rows })) };
  }
  const sqlOf = (pool) => pool.query.mock.calls[0][0].replace(/\s+/g, ' ');

  it('sin apply solo lee los DISCARDED, los más nuevos primero', async () => {
    const pool = createPool();

    await expect(resolveDiscardedEvents(pool)).resolves.toEqual([{ event_id: ID_1 }]);

    expect(sqlOf(pool)).toMatch(/^SELECT .* FROM eventos_procesados WHERE status = 'DISCARDED' AND \(\$1::uuid\[\] IS NULL OR event_id = ANY\(\$1::uuid\[\]\)\) ORDER BY processed_at DESC, event_id LIMIT \$2$/);
    expect(pool.query.mock.calls[0][1]).toEqual([null, DEFAULT_LIMIT]);
  });

  it('sin apply y con ids filtra por esos ids', async () => {
    const pool = createPool();
    await resolveDiscardedEvents(pool, { ids: [ID_1], limit: 5 });
    expect(pool.query.mock.calls[0][1]).toEqual([[ID_1], 5]);
  });

  it('con apply borra solo filas DISCARDED de esos ids', async () => {
    const pool = createPool();

    await resolveDiscardedEvents(pool, { ids: [ID_1, ID_2], apply: true });

    expect(sqlOf(pool)).toMatch(/^DELETE FROM eventos_procesados WHERE status = 'DISCARDED' AND event_id = ANY\(\$1::uuid\[\]\) RETURNING /);
    expect(pool.query.mock.calls[0][1]).toEqual([[ID_1, ID_2]]);
  });

  it('con apply y sin ids no toca la base', async () => {
    const pool = createPool();
    await expect(resolveDiscardedEvents(pool, { apply: true })).rejects.toThrow(/no se borran descartados en masa/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
