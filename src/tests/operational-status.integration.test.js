const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../app');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { NotFoundError } = require('../errors/app-errors');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

const OFFICER = { sub: 'of-001', groups: ['officer'] };
const OTHER_OFFICER = { sub: 'of-002', groups: ['officer'] };

describe('Estado operativo del oficial (integración contra Postgres real)', () => {
  let pool;
  let repository;

  function appAs(user) {
    return createApp(mockKafkaService, repository, {
      authenticate: (req, res, next) => { req.user = user; next(); },
    });
  }

  // Deja una emergencia DISPATCHED asignada al oficial dado, por los mismos
  // caminos que usa la API (create → validar → asignar).
  const createdIds = [];

  async function createDispatched(officerId = 'of-001') {
    const id = randomUUID();
    createdIds.push(id);
    await repository.create({
      id, userId: 'user-op-status', latitude: -34.6037, longitude: -58.3816, description: 'op status', severity: 'high',
    });
    await repository.updateStatus(id, { newStatus: 'VALIDATED', actor: 'D1' });
    await repository.assignOfficer(id, { officerId, actor: 'D1' });
    return id;
  }

  const statusOf = async (id) => (await pool.query('SELECT status FROM emergencies WHERE id = $1', [id])).rows[0].status;

  beforeAll(() => {
    process.env.LOCATION_ENCRYPTION_KEY = process.env.LOCATION_ENCRYPTION_KEY
      || 'flxqyJtbe6+mibyHqK76N6LSnFe0w22hnyDZg9KWIcs=';
    pool = getPool();
    repository = new EmergencyRepository(pool);
  });

  beforeEach(async () => {
    // Otros tests asignan estos oficiales y los dejan ocupados.
    await pool.query("UPDATE officers SET status = 'disponible' WHERE id IN ('of-001', 'of-002')");
  });

  afterAll(async () => {
    // Las suites de integración comparten base: lo que crea esta suite no debe
    // alterar el agrupamiento de incidentes de las otras.
    await pool.query('DELETE FROM emergency_status_history WHERE emergency_id = ANY($1::uuid[])', [createdIds]);
    await pool.query("DELETE FROM outbox_events WHERE payload->'data'->>'id' = ANY($1::text[])", [createdIds]);
    await pool.query('DELETE FROM emergencies WHERE id = ANY($1::uuid[])', [createdIds]);
    await pool.query("UPDATE officers SET status = 'disponible' WHERE id IN ('of-001', 'of-002')");
    await closePool();
  });

  it('recorre el flujo completo y deja historial con el oficial como actor', async () => {
    const id = await createDispatched();
    const app = appAs(OFFICER);

    await request(app).patch(`/api/emergencies/${id}/en-route`).expect(200);
    await request(app).patch(`/api/emergencies/${id}/on-scene`).expect(200);
    const resolved = await request(app).patch(`/api/emergencies/${id}/resolve`).expect(200);

    expect(resolved.body.data.status).toBe('RESOLVED');
    const history = await pool.query(
      `SELECT previous_status, new_status, actor FROM emergency_status_history
       WHERE emergency_id = $1 ORDER BY id`,
      [id]
    );
    expect(history.rows.slice(-3)).toEqual([
      { previous_status: 'DISPATCHED', new_status: 'EN_ROUTE', actor: 'of-001' },
      { previous_status: 'EN_ROUTE', new_status: 'ON_SCENE', actor: 'of-001' },
      { previous_status: 'ON_SCENE', new_status: 'RESOLVED', actor: 'of-001' },
    ]);
  });

  it('cada avance deja un EmergenciaActualizada en el outbox, en la misma transacción', async () => {
    const id = await createDispatched();

    await request(appAs(OFFICER)).patch(`/api/emergencies/${id}/en-route`).expect(200);
    await request(appAs(OFFICER)).patch(`/api/emergencies/${id}/on-scene`).expect(200);

    const outbox = await pool.query(
      `SELECT topic, payload FROM outbox_events
       WHERE payload->'data'->>'emergenciaId' = $1
         AND payload->>'type' = 'EmergenciaActualizada'
         AND payload->'data'->>'estadoNuevo' IN ('EN_CAMINO', 'EN_LUGAR')
       ORDER BY created_at`,
      [id]
    );
    expect(outbox.rows.map((r) => r.payload.data.estadoNuevo)).toEqual(['EN_CAMINO', 'EN_LUGAR']);
    expect(outbox.rows.every((r) => r.topic === 'emergencias.estado-actualizado')).toBe(true);
    expect(outbox.rows[0].payload.data).toMatchObject({ estadoAnterior: 'DESPACHADA', usuarioId: 'of-001' });
  });

  it('otro oficial recibe 404 y la emergencia queda intacta', async () => {
    const id = await createDispatched('of-001');

    await request(appAs(OTHER_OFFICER)).patch(`/api/emergencies/${id}/en-route`).expect(404);

    expect(await statusOf(id)).toBe('DISPATCHED');
    const history = await pool.query(
      "SELECT 1 FROM emergency_status_history WHERE emergency_id = $1 AND new_status = 'EN_ROUTE'",
      [id]
    );
    expect(history.rows).toHaveLength(0);
  });

  it('saltear un estado responde 409 y no cambia nada', async () => {
    const id = await createDispatched();

    await request(appAs(OFFICER)).patch(`/api/emergencies/${id}/on-scene`).expect(409);
    await request(appAs(OFFICER)).patch(`/api/emergencies/${id}/resolve`).expect(409);

    expect(await statusOf(id)).toBe('DISPATCHED');
  });

  it('repetir un avance ya aplicado responde 409', async () => {
    const id = await createDispatched();
    await request(appAs(OFFICER)).patch(`/api/emergencies/${id}/en-route`).expect(200);

    await request(appAs(OFFICER)).patch(`/api/emergencies/${id}/en-route`).expect(409);

    expect(await statusOf(id)).toBe('EN_ROUTE');
  });

  it('una emergencia devuelta por el dispatcher ya no la puede avanzar el oficial', async () => {
    const id = await createDispatched();
    await repository.updateStatus(id, { newStatus: 'VALIDATED', actor: 'D1', reason: 'devuelta' });

    // La devolución libera al oficial y limpia assigned_officer_id: para el
    // permiso la emergencia ya no es suya, así que responde 404 (no 409).
    await request(appAs(OFFICER)).patch(`/api/emergencies/${id}/en-route`).expect(404);
    expect(await statusOf(id)).toBe('VALIDATED');
  });

  it('el lock del repositorio rechaza si el oficial cambió entre la lectura y el UPDATE', async () => {
    const id = await createDispatched('of-001');

    // Lo que vería el controller si el dispatcher devolviera y reasignara a
    // of-002 justo entre findById y updateStatus.
    await expect(
      repository.updateStatus(id, { newStatus: 'EN_ROUTE', actor: 'of-002', requireAssignedOfficerId: 'of-002' })
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await statusOf(id)).toBe('DISPATCHED');
  });

  it('sin requireAssignedOfficerId el repositorio se comporta como antes (dispatcher)', async () => {
    const id = await createDispatched('of-001');

    const { emergency } = await repository.updateStatus(id, { newStatus: 'EN_ROUTE', actor: 'D1' });

    expect(emergency.status).toBe('EN_ROUTE');
  });

  it('el oficial sigue ocupado al resolver: se libera recién cuando el dispatcher cierra', async () => {
    // Documenta el comportamiento actual (ver nota para Producto en el PR):
    // updateStatus libera al oficial solo al cancelar, cerrar o devolver.
    const id = await createDispatched('of-001');
    const app = appAs(OFFICER);
    await request(app).patch(`/api/emergencies/${id}/en-route`).expect(200);
    await request(app).patch(`/api/emergencies/${id}/on-scene`).expect(200);
    await request(app).patch(`/api/emergencies/${id}/resolve`).expect(200);

    const busy = await pool.query("SELECT status FROM officers WHERE id = 'of-001'");
    expect(busy.rows[0].status).toBe('ocupado');

    await request(appAs({ sub: 'D1', groups: ['dispatcher'] })).patch(`/api/emergencies/${id}/close`).expect(200);

    const freed = await pool.query("SELECT status FROM officers WHERE id = 'of-001'");
    expect(freed.rows[0].status).toBe('disponible');
  });
});
