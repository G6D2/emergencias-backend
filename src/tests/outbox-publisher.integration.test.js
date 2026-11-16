// OutboxPublisher contra Postgres real: el lote reclamado se publica en orden
// de creación. UPDATE ... RETURNING no garantiza ningún orden, así que varios
// cambios de estado de una misma emergencia que caían en el mismo poll podían
// salir al bus desordenados (CERRADA antes que RESUELTA).
//
// Kafka no corre: se inyecta un publisher que anota lo que le llega.

const { randomUUID } = require('crypto');
const { getPool } = require('../db/pool');
const { OutboxPublisher } = require('../services/outbox-publisher');

const TOPIC = `test.outbox.orden.${randomUUID().slice(0, 8)}`;
const ESTADOS = ['VALIDADA', 'DESPACHADA', 'EN_CAMINO', 'EN_LUGAR', 'RESUELTA', 'CERRADA'];
// Las filas de este test se crean "mañana" y el publisher arranca con ese piso:
// así no reclama eventos que hayan dejado otros tests.
const BASE = Date.now() + 24 * 60 * 60 * 1000;

let pool;

function capturingPublisher() {
  const sent = [];
  return {
    sent,
    isEnabled: () => true,
    publishEvent: async (topic, payload) => {
      if (topic === TOPIC) sent.push(payload.data.estadoNuevo);
      return true;
    },
  };
}

async function insertEvent(estadoNuevo, createdAt, emergenciaId) {
  await pool.query(
    `INSERT INTO outbox_events (id, topic, payload, created_at) VALUES ($1, $2, $3::jsonb, $4)`,
    [randomUUID(), TOPIC, JSON.stringify({ type: 'EmergenciaActualizada', data: { emergenciaId, estadoNuevo } }), createdAt]
  );
}

beforeAll(() => {
  pool = getPool();
});

afterEach(async () => {
  await pool.query('DELETE FROM outbox_events WHERE topic = $1', [TOPIC]);
});

afterAll(async () => {
  await pool.end();
});

describe('OutboxPublisher: orden de publicación', () => {
  it('publica el lote en orden de creación aunque las filas estén guardadas en otro orden', async () => {
    const emergenciaId = randomUUID();
    // Se insertan del más nuevo al más viejo: el orden físico es el inverso al
    // cronológico, que es el caso que desordenaba la publicación.
    for (let i = ESTADOS.length - 1; i >= 0; i -= 1) {
      await insertEvent(ESTADOS[i], new Date(BASE + i * 1000).toISOString(), emergenciaId);
    }
    const publisher = capturingPublisher();
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, {
      publisher,
      publishSince: new Date(BASE - 1000),
    });

    await expect(outbox.runOnce()).resolves.toBeGreaterThanOrEqual(ESTADOS.length);

    expect(publisher.sent).toEqual(ESTADOS);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS published FROM outbox_events WHERE topic = $1 AND status = $2',
      [TOPIC, 'PUBLISHED']
    );
    expect(rows[0].published).toBe(ESTADOS.length);
  });

  it('un evento reintentado vuelve a entrar al lote en su lugar por fecha de creación', async () => {
    const emergenciaId = randomUUID();
    await insertEvent('EN_CAMINO', new Date(BASE + 2000).toISOString(), emergenciaId);
    await insertEvent('VALIDADA', new Date(BASE).toISOString(), emergenciaId);
    await insertEvent('DESPACHADA', new Date(BASE + 1000).toISOString(), emergenciaId);
    // DESPACHADA ya falló una vez: el UPDATE la mueve físicamente al final.
    await pool.query(
      `UPDATE outbox_events SET attempts = 1, last_error = 'gateway 503'
       WHERE topic = $1 AND payload->'data'->>'estadoNuevo' = 'DESPACHADA'`,
      [TOPIC]
    );
    const publisher = capturingPublisher();
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, {
      publisher,
      publishSince: new Date(BASE - 1000),
    });

    await outbox.runOnce();

    expect(publisher.sent).toEqual(['VALIDADA', 'DESPACHADA', 'EN_CAMINO']);
  });
});

describe('OutboxPublisher: dos procesos sobre la misma fila (lock vencido)', () => {
  // Caso del backup de Render (16/11): el proceso A reclama la fila y tarda más
  // de 1 minuto en fallar; B la vuelve a reclamar por lock vencido y la publica.
  // Cuando A por fin falla, no tiene que pisar el PUBLISHED de B con PENDING.
  it('el markFailed tardío del primer reclamo no pisa el PUBLISHED del segundo', async () => {
    await insertEvent('VALIDADA', new Date(BASE).toISOString(), randomUUID());
    const since = new Date(BASE - 1000);
    const procesoA = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: capturingPublisher(), publishSince: since });
    const publisherB = capturingPublisher();
    const procesoB = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: publisherB, publishSince: since });

    const [claimA] = (await procesoA.claimBatch()).filter((e) => e.topic === TOPIC);
    expect(claimA.attempts).toBe(1);
    // Simula que A lleva más de 1 minuto con la fila.
    await pool.query(
      `UPDATE outbox_events SET locked_at = now() - interval '2 minutes' WHERE id = $1`,
      [claimA.id]
    );

    await procesoB.runOnce();
    expect(publisherB.sent).toEqual(['VALIDADA']);

    await expect(procesoA.markFailed(claimA.id, claimA.attempts, new Error('kafka timeout'))).resolves.toBe(false);
    await expect(procesoA.markPublished(claimA.id, claimA.attempts)).resolves.toBe(false);

    const { rows } = await pool.query('SELECT status, attempts FROM outbox_events WHERE id = $1', [claimA.id]);
    expect(rows[0]).toEqual({ status: 'PUBLISHED', attempts: 2 });
  });

  it('el dueño actual del reclamo sí puede marcarla', async () => {
    await insertEvent('VALIDADA', new Date(BASE).toISOString(), randomUUID());
    const proceso = new OutboxPublisher(pool, { isEnabled: () => true }, {
      publisher: capturingPublisher(), publishSince: new Date(BASE - 1000), maxAttempts: 5,
    });

    const [claim] = (await proceso.claimBatch()).filter((e) => e.topic === TOPIC);
    await expect(proceso.markFailed(claim.id, claim.attempts, new Error('503'))).resolves.toBe(true);

    const { rows } = await pool.query('SELECT status FROM outbox_events WHERE id = $1', [claim.id]);
    expect(rows[0].status).toBe('PENDING');
  });
});
