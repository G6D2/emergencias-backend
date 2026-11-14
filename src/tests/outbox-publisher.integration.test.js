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
