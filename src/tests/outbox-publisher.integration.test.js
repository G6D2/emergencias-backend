// OutboxPublisher contra Postgres real: el lote reclamado se publica en orden
// de creación. UPDATE ... RETURNING no garantiza ningún orden, así que varios
// cambios de estado de una misma emergencia que caían en el mismo poll podían
// salir al bus desordenados (CERRADA antes que RESUELTA).
//
// Kafka no corre: se inyecta un publisher que anota lo que le llega.

const { randomUUID } = require('crypto');
const { getPool } = require('../db/pool');
const { OutboxPublisher } = require('../services/outbox-publisher');
const { resolveFailedEvents } = require('../services/outbox-failed');

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
      publisher: capturingPublisher(), publishSince: new Date(BASE - 1000),
    });

    const [claim] = (await proceso.claimBatch()).filter((e) => e.topic === TOPIC);
    await expect(proceso.markFailed(claim.id, claim.attempts, new Error('503'))).resolves.toBe(true);

    const { rows } = await pool.query('SELECT status FROM outbox_events WHERE id = $1', [claim.id]);
    expect(rows[0].status).toBe('PENDING');
  });
});

// Issue #104: caída larga del gateway y orden por emergencia, contra Postgres.
describe('OutboxPublisher ante una caída del gateway (issue #104)', () => {
  const since = new Date(BASE - 1000);

  async function insertRow({ emergenciaId, estadoNuevo, at, status = 'PENDING', attempts = 0, availableInMs = 0 }) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO outbox_events (id, topic, payload, created_at, status, attempts, available_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, now() + ($7::double precision * interval '1 millisecond'))`,
      [
        id, TOPIC,
        JSON.stringify({ type: 'EmergenciaActualizada', data: { emergenciaId, estadoNuevo } }),
        new Date(BASE + at).toISOString(), status, attempts, availableInMs,
      ]
    );
    return id;
  }

  async function rowsByTopic() {
    const { rows } = await pool.query(
      `SELECT payload->'data'->>'emergenciaId' AS emergencia, payload->'data'->>'estadoNuevo' AS estado,
              status, attempts
       FROM outbox_events WHERE topic = $1 ORDER BY created_at, id`,
      [TOPIC]
    );
    return rows;
  }

  // El gateway: caído mientras `down` sea true (503); anota cada envío de este
  // tópico. Los de otros tests (si los hubiera) salen bien.
  function flakyGateway() {
    const gateway = {
      down: true,
      calls: 0,
      sent: [],
      isEnabled: () => true,
      publishEvent: async (topic, payload) => {
        if (topic !== TOPIC) return { eventId: null, payloadHash: null };
        gateway.calls += 1;
        if (gateway.down) throw new Error('Gateway 503: Service Unavailable');
        gateway.sent.push(`${payload.data.emergenciaId}:${payload.data.estadoNuevo}`);
        return { eventId: null, payloadHash: null };
      },
    };
    return gateway;
  }

  // Simula el paso del tiempo: vence la pausa del publisher y los backoffs.
  async function letTimePass(outbox, clock) {
    clock.now += outbox.maxPauseMs + 1;
    await pool.query(
      "UPDATE outbox_events SET available_at = now() WHERE topic = $1 AND status = 'PENDING'",
      [TOPIC]
    );
  }

  it('una caída más larga que los viejos 10 intentos (~75 min) no pierde ningún evento y al volver sale todo, en orden', async () => {
    const x = randomUUID();
    const y = randomUUID();
    await insertRow({ emergenciaId: x, estadoNuevo: 'VALIDADA', at: 0 });
    await insertRow({ emergenciaId: y, estadoNuevo: 'VALIDADA', at: 1000 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'DESPACHADA', at: 2000 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'RESUELTA', at: 3000 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'CERRADA', at: 4000 });
    const gateway = flakyGateway();
    const clock = { now: Date.now() };
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, {
      publisher: gateway, publishSince: since, now: () => clock.now,
    });

    // 15 corridas con el gateway caído: cada una prueba con un solo envío y
    // corta (antes cada corrida insistía con todo el lote).
    for (let round = 1; round <= 15; round += 1) {
      await outbox.runOnce();
      expect(gateway.calls).toBe(round);
      expect(outbox.isPaused()).toBe(true);
      await letTimePass(outbox, clock);
    }

    const duringOutage = await rowsByTopic();
    expect(duringOutage.map((row) => row.status)).toEqual(Array(5).fill('PENDING'));
    // Los intentos cuentan envíos reales: entre todos, las 15 pruebas. La
    // primera fila pasó de largo los 10 que antes la dejaban FAILED.
    expect(duringOutage.reduce((sum, row) => sum + row.attempts, 0)).toBe(15);
    expect(Math.max(...duringOutage.map((row) => row.attempts))).toBeGreaterThan(10);

    gateway.down = false;
    await outbox.runOnce();

    expect(gateway.sent).toEqual([
      `${x}:VALIDADA`, `${y}:VALIDADA`, `${x}:DESPACHADA`, `${x}:RESUELTA`, `${x}:CERRADA`,
    ]);
    expect((await rowsByTopic()).map((row) => row.status)).toEqual(Array(5).fill('PUBLISHED'));
    expect(outbox.health()).toMatchObject({ pausedUntil: null, consecutiveFailures: 0 });
  });

  it('un evento con reintento programado para después frena a los posteriores de su emergencia, no a los demás', async () => {
    const x = randomUUID();
    const y = randomUUID();
    // RESUELTA falló varias veces y quedó programada a 15 min; CERRADA, más
    // nueva, está disponible ya. Antes salía CERRADA primero.
    await insertRow({ emergenciaId: x, estadoNuevo: 'RESUELTA', at: 0, attempts: 5, availableInMs: 15 * 60 * 1000 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'CERRADA', at: 1000 });
    await insertRow({ emergenciaId: y, estadoNuevo: 'VALIDADA', at: 2000 });
    const gateway = flakyGateway();
    gateway.down = false;
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: gateway, publishSince: since });

    await outbox.runOnce();
    expect(gateway.sent).toEqual([`${y}:VALIDADA`]);

    await pool.query(
      "UPDATE outbox_events SET available_at = now() WHERE topic = $1 AND payload->'data'->>'estadoNuevo' = 'RESUELTA'",
      [TOPIC]
    );
    await outbox.runOnce();
    expect(gateway.sent).toEqual([`${y}:VALIDADA`, `${x}:RESUELTA`, `${x}:CERRADA`]);
  });

  it('un FAILED frena a los posteriores de su emergencia hasta que se lo reencola', async () => {
    const x = randomUUID();
    const failedId = await insertRow({ emergenciaId: x, estadoNuevo: 'VALIDADA', at: 0, status: 'FAILED', attempts: 1 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'DESPACHADA', at: 1000 });
    const gateway = flakyGateway();
    gateway.down = false;
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: gateway, publishSince: since });

    await outbox.runOnce();
    expect(gateway.sent).toEqual([]);

    const listed = await resolveFailedEvents(pool, { ids: [failedId] });
    expect(listed).toEqual([expect.objectContaining({ id: failedId, emergencia_id: x, type: 'EmergenciaActualizada' })]);
    expect((await rowsByTopic())[0].status).toBe('FAILED');

    await resolveFailedEvents(pool, { ids: [failedId], apply: true });
    await outbox.runOnce();
    expect(gateway.sent).toEqual([`${x}:VALIDADA`, `${x}:DESPACHADA`]);
  });

  it('descartar el FAILED (SKIPPED) libera a los posteriores', async () => {
    const x = randomUUID();
    const failedId = await insertRow({ emergenciaId: x, estadoNuevo: 'VALIDADA', at: 0, status: 'FAILED', attempts: 1 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'DESPACHADA', at: 1000 });
    const gateway = flakyGateway();
    gateway.down = false;
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: gateway, publishSince: since });

    const [discarded] = await resolveFailedEvents(pool, { ids: [failedId], apply: true, discard: true });
    expect(discarded.last_error).toMatch(/^descartado a mano/);
    await outbox.runOnce();

    expect(gateway.sent).toEqual([`${x}:DESPACHADA`]);
  });

  it('con dos instancias, la segunda no reclama el siguiente evento mientras la primera tiene el anterior', async () => {
    const x = randomUUID();
    await insertRow({ emergenciaId: x, estadoNuevo: 'VALIDADA', at: 0 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'DESPACHADA', at: 1000 });
    const a = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: flakyGateway(), publishSince: since });
    const b = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: flakyGateway(), publishSince: since });

    const claimedByA = (await a.claimBatch()).filter((row) => row.topic === TOPIC);
    expect(claimedByA.map((row) => row.payload.data.estadoNuevo)).toEqual(['VALIDADA']);
    expect((await b.claimBatch()).filter((row) => row.topic === TOPIC)).toEqual([]);

    await a.markPublished(claimedByA[0].id, claimedByA[0].attempts);
    const claimedByB = (await b.claimBatch()).filter((row) => row.topic === TOPIC);
    expect(claimedByB.map((row) => row.payload.data.estadoNuevo)).toEqual(['DESPACHADA']);
  });

  it('una fila huérfana (PROCESSING con lock vencido) se reclama primero y sigue frenando a las posteriores', async () => {
    const x = randomUUID();
    const orphan = await insertRow({ emergenciaId: x, estadoNuevo: 'VALIDADA', at: 0, status: 'PROCESSING', attempts: 1 });
    await pool.query("UPDATE outbox_events SET locked_at = now() - interval '2 minutes' WHERE id = $1", [orphan]);
    await insertRow({ emergenciaId: x, estadoNuevo: 'DESPACHADA', at: 1000 });
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: flakyGateway(), publishSince: since });

    const claimed = (await outbox.claimBatch()).filter((row) => row.topic === TOPIC);

    expect(claimed.map((row) => [row.id, row.attempts])).toEqual([[orphan, 2]]);
  });

  it('SKIPPED y PENDING anteriores a publishSince no frenan', async () => {
    const x = randomUUID();
    await insertRow({ emergenciaId: x, estadoNuevo: 'VALIDADA', at: 0, status: 'SKIPPED' });
    await insertRow({ emergenciaId: x, estadoNuevo: 'DESPACHADA', at: 1000 });
    await insertRow({ emergenciaId: x, estadoNuevo: 'EN_CAMINO', at: 2000 });
    const gateway = flakyGateway();
    gateway.down = false;
    // El piso queda entre DESPACHADA y EN_CAMINO: DESPACHADA no se publica
    // (se descartaría al arrancar) y no frena a EN_CAMINO.
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, {
      publisher: gateway, publishSince: new Date(BASE + 1500),
    });

    await outbox.runOnce();

    expect(gateway.sent).toEqual([`${x}:EN_CAMINO`]);
  });

  it('un evento sin emergencia (sin data.emergenciaId ni data.id) no espera a nadie', async () => {
    await pool.query(
      `INSERT INTO outbox_events (id, topic, payload, created_at, status)
       VALUES ($1, $2, '{"type":"Otro","data":{}}'::jsonb, $3, 'FAILED'), ($4, $2, '{"type":"Otro","data":{}}'::jsonb, $5, 'PENDING')`,
      [randomUUID(), TOPIC, new Date(BASE).toISOString(), randomUUID(), new Date(BASE + 1000).toISOString()]
    );
    const outbox = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: flakyGateway(), publishSince: since });

    const claimed = (await outbox.claimBatch()).filter((row) => row.topic === TOPIC);

    expect(claimed).toHaveLength(1);
  });
});
