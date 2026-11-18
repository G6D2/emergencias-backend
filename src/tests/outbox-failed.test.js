const { parseRequeueFailedArgs, resolveFailedEvents, USAGE } = require('../services/outbox-failed');

const ID_1 = '3f1c2b9e-5d8a-4c7b-9e2f-1a2b3c4d5e6f';
const ID_2 = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';

describe('parseRequeueFailedArgs', () => {
  it('sin argumentos solo lista, sobre todos los FAILED', () => {
    expect(parseRequeueFailedArgs([])).toEqual({ ids: [], discard: false, apply: false, help: false });
  });

  it('lee --apply, --skip, --help y varios --id', () => {
    expect(parseRequeueFailedArgs(['--id', ID_1, '--skip', '--id', ID_2, '--apply'])).toEqual({
      ids: [ID_1, ID_2], discard: true, apply: true, help: false,
    });
    expect(parseRequeueFailedArgs(['-h']).help).toBe(true);
    expect(parseRequeueFailedArgs(['--help']).help).toBe(true);
  });

  it.each([
    [['--id'], /--id necesita un UUID \(vino nada\)/],
    [['--id', 'no-es-uuid'], /--id necesita un UUID \(vino "no-es-uuid"\)/],
    [['--todo'], /Argumento desconocido: --todo/],
  ])('rechaza %p', (argv, message) => {
    expect(() => parseRequeueFailedArgs(argv)).toThrow(message);
  });

  it('el uso explica que sin --apply no cambia nada', () => {
    expect(USAGE).toMatch(/sin --apply\s+lista/);
  });
});

describe('resolveFailedEvents', () => {
  function createPool(rows = [{ id: ID_1 }]) {
    return { query: jest.fn(async () => ({ rows })) };
  }
  const sqlOf = (pool) => pool.query.mock.calls[0][0].replace(/\s+/g, ' ');

  it('sin apply solo lee los FAILED (todos si no hay ids)', async () => {
    const pool = createPool();

    await expect(resolveFailedEvents(pool)).resolves.toEqual([{ id: ID_1 }]);

    expect(sqlOf(pool)).toMatch(/^SELECT .* FROM outbox_events WHERE status = 'FAILED' AND \(\$1::uuid\[\] IS NULL OR id = ANY\(\$1::uuid\[\]\)\) ORDER BY created_at, id$/);
    expect(sqlOf(pool)).toContain("COALESCE(outbox_events.payload->'data'->>'emergenciaId', outbox_events.payload->'data'->>'id') AS emergencia_id");
    expect(pool.query.mock.calls[0][1]).toEqual([null]);
  });

  it('con apply los reencola (PENDING, disponibles ya) sin tocar attempts', async () => {
    const pool = createPool();

    await resolveFailedEvents(pool, { ids: [ID_1], apply: true });

    const sql = sqlOf(pool);
    expect(sql).toMatch(/^UPDATE outbox_events SET status = 'PENDING', available_at = now\(\), locked_at = NULL WHERE status = 'FAILED'/);
    expect(sql).not.toMatch(/attempts =/);
    expect(pool.query.mock.calls[0][1]).toEqual([[ID_1]]);
  });

  it('con apply y discard los descarta (SKIPPED) y deja constancia en last_error', async () => {
    const pool = createPool();

    await resolveFailedEvents(pool, { apply: true, discard: true });

    const sql = sqlOf(pool);
    expect(sql).toMatch(/^UPDATE outbox_events SET status = 'SKIPPED'/);
    expect(sql).toContain("left('descartado a mano (outbox:requeue-failed --skip): ' || COALESCE(last_error, ''), 2000)");
    expect(pool.query.mock.calls[0][1]).toEqual([null]);
  });

  it('discard sin apply sigue siendo solo lectura', async () => {
    const pool = createPool();

    await resolveFailedEvents(pool, { discard: true });

    expect(sqlOf(pool)).toMatch(/^SELECT /);
  });
});
