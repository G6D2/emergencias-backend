// npm run eventos:descartados contra Postgres real: lista solo los DISCARDED
// y, con --apply, borra la fila de dedup de un DISCARDED sin tocar nunca una
// PROCESSED (su reentrega aplicaría los efectos dos veces).

const { getPool } = require('../db/pool');
const { EventosProcesadosRepository } = require('../repositories/eventos-procesados.repository');
const { resolveDiscardedEvents } = require('../services/eventos-descartados');

const PROCESADO = 'd1000000-0000-4000-8000-000000000001';
const DESCARTADO = 'd1000000-0000-4000-8000-000000000002';

let pool;
let repo;

beforeAll(() => {
  pool = getPool();
  repo = new EventosProcesadosRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await repo.tryMarkProcessed(null, { eventId: PROCESADO, source: 'grupo7', eventType: 'EventoComunitarioPublicado' });
  await repo.markDiscarded(null, {
    eventId: DESCARTADO, source: 'grupo7', eventType: 'EventoCancelado', reason: 'No hay un handler registrado para CancelarCobertura',
  });
});

afterEach(async () => {
  await pool.query('DELETE FROM eventos_procesados');
});

describe('eventos-descartados (integration)', () => {
  it('lista solo los DISCARDED, con el motivo', async () => {
    const rows = await resolveDiscardedEvents(pool);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: DESCARTADO,
      source: 'grupo7',
      event_type: 'EventoCancelado',
      discard_reason: 'No hay un handler registrado para CancelarCobertura',
    });
  });

  it('con apply borra el DISCARDED y deja intacto el PROCESSED aunque se lo pida', async () => {
    const borradas = await resolveDiscardedEvents(pool, { ids: [DESCARTADO, PROCESADO], apply: true });

    expect(borradas.map((row) => row.event_id)).toEqual([DESCARTADO]);
    expect(await repo.findById(DESCARTADO)).toBeNull();
    expect(await repo.findById(PROCESADO)).toMatchObject({ status: 'PROCESSED' });
  });
});
