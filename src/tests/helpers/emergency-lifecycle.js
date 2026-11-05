const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../../app');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { OfficerRepository } = require('../../repositories/officer.repository');
const { createLocalJwtAuth } = require('./local-jwt');

// Arnés para los tests de integración que recorren una emergencia por HTTP
// contra Postgres real: app armada como en src/index.js (repositorios reales,
// authenticate real con JWT RS256 local), identidades con token propio y
// helpers para leer historial, outbox y oficiales. Kafka no corre: los
// eventos quedan en outbox_events, que es lo que se verifica.

const OFFICER_ID = 'of-001';
const OTHER_OFFICER_ID = 'of-002';
const LOCATION = Object.freeze({ latitude: -34.6037, longitude: -58.3816 });

const topicCreada = () => process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico';
const topicActualizada = () => process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado';

const kafkaApagado = {
  isEnabled: () => false,
  publishEvent: async () => false,
  checkHealth: async () => false,
};

function expectStatus(res, expected, label) {
  if (res.status !== expected) {
    throw new Error(
      `${label}: se esperaba HTTP ${expected} y vino ${res.status} ${JSON.stringify(res.body)}`
    );
  }
  return res;
}

async function createLifecycleHarness(pool) {
  // Sin rate limit: la suite dispara varios POST /api/panic-button seguidos
  // desde la misma IP (el límite real es 5/min). Se lee al armar la app.
  process.env.RATE_LIMIT_ENABLED = 'false';

  const tag = randomUUID().slice(0, 8);
  const auth = await createLocalJwtAuth();
  const emergencyRepository = new EmergencyRepository(pool);
  const app = createApp(kafkaApagado, emergencyRepository, {
    authenticate: auth.authenticate,
    officerRepository: new OfficerRepository(pool),
  });

  const identities = {
    citizen: { sub: `cit-ciclo-${tag}`, groups: ['citizen'] },
    otherCitizen: { sub: `cit-otro-${tag}`, groups: ['citizen'] },
    dispatcher: { sub: `disp-ciclo-${tag}`, groups: ['dispatcher'] },
    officer: { sub: OFFICER_ID, groups: ['officer'] },
    otherOfficer: { sub: OTHER_OFFICER_ID, groups: ['officer'] },
  };
  const bearers = {};
  for (const [name, identity] of Object.entries(identities)) {
    bearers[name] = await auth.bearerFor(identity);
  }

  const createdIds = [];

  function call(method, path, as, body) {
    const req = request(app)[method](path).set('Authorization', bearers[as]);
    return body === undefined ? req : req.send(body);
  }

  async function panic(as = 'citizen', body = {}) {
    const res = await call('post', '/api/panic-button', as, { location: LOCATION, ...body });
    if (res.status === 201) createdIds.push(res.body.emergencyId);
    return res;
  }

  const patch = (id, action, as, body) => call('patch', `/api/emergencies/${id}/${action}`, as, body);

  async function createPending(body) {
    const res = expectStatus(await panic('citizen', body), 201, 'POST /api/panic-button');
    return res.body.emergencyId;
  }

  async function createValidated(body) {
    const id = await createPending(body);
    expectStatus(await patch(id, 'validate', 'dispatcher'), 200, 'validate');
    return id;
  }

  async function createDispatched(officerId = OFFICER_ID) {
    const id = await createValidated();
    expectStatus(await patch(id, 'assign', 'dispatcher', { officerId }), 200, 'assign');
    return id;
  }

  // Camino feliz completo: pánico → validate → assign of-001 → en-route →
  // on-scene → resolve (of-001) → close. Devuelve el id y lo que se vio en
  // el medio (estado del oficial antes de cerrar).
  async function runFullLifecycle() {
    const id = await createPending({ emergencyType: 'MEDICA', description: 'ciclo completo' });
    expectStatus(await patch(id, 'validate', 'dispatcher'), 200, 'validate');
    const assigned = expectStatus(
      await patch(id, 'assign', 'dispatcher', { officerId: OFFICER_ID }), 200, 'assign'
    );
    const officerAfterAssign = await officerStatus(OFFICER_ID);
    expectStatus(await patch(id, 'en-route', 'officer'), 200, 'en-route');
    expectStatus(await patch(id, 'on-scene', 'officer'), 200, 'on-scene');
    const resolved = expectStatus(await patch(id, 'resolve', 'officer'), 200, 'resolve');
    const officerAfterResolve = await officerStatus(OFFICER_ID);
    const closed = expectStatus(await patch(id, 'close', 'dispatcher'), 200, 'close');
    return { id, assigned, resolved, closed, officerAfterAssign, officerAfterResolve };
  }

  async function historyOf(id) {
    const { rows } = await pool.query(
      `SELECT previous_status, new_status, actor, reason
       FROM emergency_status_history WHERE emergency_id = $1 ORDER BY id`,
      [id]
    );
    return rows;
  }

  async function outboxOf(id) {
    const { rows } = await pool.query(
      `SELECT id, topic, status, payload
       FROM outbox_events
       WHERE payload->'data'->>'emergenciaId' = $1
       ORDER BY created_at, id`,
      [id]
    );
    return rows;
  }

  async function emergencyRow(id) {
    const { rows } = await pool.query('SELECT * FROM emergencies WHERE id = $1', [id]);
    return rows[0];
  }

  async function officerStatus(officerId) {
    const { rows } = await pool.query('SELECT status FROM officers WHERE id = $1', [officerId]);
    return rows[0] && rows[0].status;
  }

  // Otras suites dejan oficiales ocupados; cada test arranca con los dos libres.
  async function resetOfficers() {
    await pool.query(
      "UPDATE officers SET status = 'disponible', updated_at = now() WHERE id = ANY($1::text[])",
      [[OFFICER_ID, OTHER_OFFICER_ID]]
    );
  }

  // Borra solo lo que creó esta suite (la base es compartida entre suites).
  async function cleanup() {
    if (createdIds.length > 0) {
      await pool.query(
        "DELETE FROM outbox_events WHERE payload->'data'->>'emergenciaId' = ANY($1::text[])",
        [createdIds]
      );
      // historial y auditoría de acceso caen por ON DELETE CASCADE.
      await pool.query('DELETE FROM emergencies WHERE id = ANY($1::uuid[])', [createdIds]);
    }
    await resetOfficers();
  }

  return {
    app,
    identities,
    bearers,
    createdIds,
    call,
    panic,
    patch,
    createPending,
    createValidated,
    createDispatched,
    runFullLifecycle,
    historyOf,
    outboxOf,
    emergencyRow,
    officerStatus,
    resetOfficers,
    cleanup,
  };
}

module.exports = {
  createLifecycleHarness,
  expectStatus,
  topicCreada,
  topicActualizada,
  OFFICER_ID,
  OTHER_OFFICER_ID,
};
