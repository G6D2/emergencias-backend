// Ciclo de vida completo de una emergencia por HTTP, de punta a punta:
// app armada como en producción (authenticate real con JWT RS256 local, sin
// stub), repositorios reales y Postgres migrado con Flyway. Verifica estado,
// historial con actor, oficial ocupado/libre, closed_at y los eventos que
// quedan en el outbox (contrato del issue #48).
//
// validate siempre desde PENDING y return siempre desde DISPATCHED. Lo que
// agregó el sweep de emergencias (#75: validate/return con estado de origen,
// assigned_officer_id en NULL al devolver, closed_at en cancel/discard y V26)
// se verifica en emergency-rules-v26.integration.test.js.

const { getPool, closePool } = require('../db/pool');
const {
  createLifecycleHarness,
  expectStatus,
  topicCreada,
  topicActualizada,
  OFFICER_ID,
  OTHER_OFFICER_ID,
} = require('./helpers/emergency-lifecycle');

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

let pool;
let h;

beforeAll(async () => {
  pool = getPool();
  h = await createLifecycleHarness(pool);
});

beforeEach(async () => {
  await h.resetOfficers();
});

afterAll(async () => {
  await h.cleanup();
  await closePool();
});

const updatesOf = (rows) => rows.filter((row) => row.payload.type === 'EmergenciaActualizada');
const lastUpdate = async (id) => updatesOf(await h.outboxOf(id)).pop().payload.data;

describe('camino feliz: pánico → validate → assign → en-route → on-scene → resolve → close', () => {
  let run;
  const startedAt = Date.now();

  beforeAll(async () => {
    await h.resetOfficers();
    run = await h.runFullLifecycle();
  });

  it('termina CLOSED, con closed_at y a nombre del ciudadano que reportó', async () => {
    const row = await h.emergencyRow(run.id);

    expect(row.status).toBe('CLOSED');
    expect(row.user_id).toBe(h.identities.citizen.sub);
    expect(row.closed_at).toBeInstanceOf(Date);
    expect(row.closed_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
    expect(run.closed.body.data).toMatchObject({ id: run.id, status: 'CLOSED' });
    expect(run.closed.body.data.closedAt).toBeTruthy();
  });

  it('assign responde con el oficial asignado y resolve con RESOLVED', () => {
    expect(run.assigned.body.data).toMatchObject({
      status: 'DISPATCHED',
      assignedOfficerId: OFFICER_ID,
      assignedOfficer: 'Oficial Carlos Gómez',
    });
    expect(run.resolved.body.data.status).toBe('RESOLVED');
  });

  it('deja una fila de historial por transición, cada una con el actor del token', async () => {
    const dispatcher = h.identities.dispatcher.sub;

    expect(await h.historyOf(run.id)).toEqual([
      { previous_status: 'PENDING', new_status: 'VALIDATED', actor: dispatcher, reason: null },
      { previous_status: 'VALIDATED', new_status: 'DISPATCHED', actor: dispatcher, reason: `Assigned officer ${OFFICER_ID}` },
      { previous_status: 'DISPATCHED', new_status: 'EN_ROUTE', actor: OFFICER_ID, reason: null },
      { previous_status: 'EN_ROUTE', new_status: 'ON_SCENE', actor: OFFICER_ID, reason: null },
      { previous_status: 'ON_SCENE', new_status: 'RESOLVED', actor: OFFICER_ID, reason: null },
      { previous_status: 'RESOLVED', new_status: 'CLOSED', actor: dispatcher, reason: null },
    ]);
  });

  it('el oficial queda ocupado al asignar, sigue ocupado al resolver y se libera al cerrar', async () => {
    expect(run.officerAfterAssign).toBe('ocupado');
    expect(run.officerAfterResolve).toBe('ocupado');
    expect(await h.officerStatus(OFFICER_ID)).toBe('disponible');
  });

  it('el detalle por HTTP muestra el mismo historial al dispatcher y al dueño; otro ciudadano recibe 404', async () => {
    const asDispatcher = expectStatus(
      await h.call('get', `/api/emergencies/${run.id}`, 'dispatcher'), 200, 'detalle dispatcher'
    );
    expect(asDispatcher.body.data.statusHistory.map((entry) => [entry.newStatus, entry.actor])).toEqual([
      ['VALIDATED', h.identities.dispatcher.sub],
      ['DISPATCHED', h.identities.dispatcher.sub],
      ['EN_ROUTE', OFFICER_ID],
      ['ON_SCENE', OFFICER_ID],
      ['RESOLVED', OFFICER_ID],
      ['CLOSED', h.identities.dispatcher.sub],
    ]);

    await h.call('get', `/api/emergencies/${run.id}`, 'citizen').expect(200);
    await h.call('get', `/api/emergencies/${run.id}`, 'otherCitizen').expect(404);
  });

  it('el outbox tiene una EmergenciaCreada y una EmergenciaActualizada por transición, en orden', async () => {
    const rows = await h.outboxOf(run.id);

    expect(rows).toHaveLength(7);
    const [creada, ...actualizadas] = rows;

    expect(creada.topic).toBe(topicCreada());
    expect(creada.payload.type).toBe('EmergenciaCreada');
    expect(creada.payload.data).toMatchObject({
      emergenciaId: run.id,
      categoria: 'MEDICA',
      prioridad: 'ALTA',
      estado: 'PENDIENTE',
      ciudadanoId: h.identities.citizen.sub,
      correlationId: run.id,
    });

    expect(actualizadas.every((row) => row.topic === topicActualizada())).toBe(true);
    expect(actualizadas.every((row) => row.payload.type === 'EmergenciaActualizada')).toBe(true);
    expect(actualizadas.map(({ payload: { data } }) => [data.estadoAnterior, data.estadoNuevo, data.usuarioId]))
      .toEqual([
        ['PENDIENTE', 'VALIDADA', h.identities.dispatcher.sub],
        ['VALIDADA', 'DESPACHADA', h.identities.dispatcher.sub],
        ['DESPACHADA', 'EN_CAMINO', OFFICER_ID],
        ['EN_CAMINO', 'EN_LUGAR', OFFICER_ID],
        ['EN_LUGAR', 'RESUELTA', OFFICER_ID],
        ['RESUELTA', 'CERRADA', h.identities.dispatcher.sub],
      ]);

    for (const row of rows) {
      // El eventId del sobre es la PK de la fila del outbox (lo usa el publisher).
      expect(row.payload.eventId).toBe(row.id);
      expect(row.payload.correlationId).toBe(run.id);
      expect(row.payload.data.emergenciaId).toBe(run.id);
      expect(row.status).toBe('PENDING');
    }
  });

  it('asignadoA viaja solo en DESPACHADA y resueltoAt solo en RESUELTA', async () => {
    const actualizadas = updatesOf(await h.outboxOf(run.id)).map((row) => row.payload.data);

    for (const data of actualizadas) {
      expect(data.asignadoA).toBe(data.estadoNuevo === 'DESPACHADA' ? OFFICER_ID : null);
      expect(data.prioridad).toBe('ALTA');
      expect(data.updatedAt).toMatch(ISO_UTC);
      if (data.estadoNuevo === 'RESUELTA') {
        expect(data.resueltoAt).toMatch(ISO_UTC);
        expect(Date.parse(data.resueltoAt)).toBeGreaterThanOrEqual(startedAt - 1000);
      } else {
        expect(data.resueltoAt).toBeNull();
      }
    }

    const despachada = actualizadas.find((data) => data.estadoNuevo === 'DESPACHADA');
    expect(despachada.resolucion).toBe(`Assigned officer ${OFFICER_ID}`);
  });
});

describe('rama cancel: el ciudadano dueño cancela', () => {
  it('otro ciudadano recibe 404; el dueño cancela con motivo y queda historial y CANCELADA en el outbox', async () => {
    const id = await h.createPending();

    await h.patch(id, 'cancel', 'otherCitizen', { reason: 'no es mía' }).expect(404);
    expect((await h.emergencyRow(id)).status).toBe('PENDING');

    const res = await h.patch(id, 'cancel', 'citizen', { reason: 'Fue una falsa alarma' }).expect(200);

    expect(res.body.data.status).toBe('CANCELLED');
    expect((await h.emergencyRow(id)).status).toBe('CANCELLED');
    expect(await h.historyOf(id)).toEqual([
      { previous_status: 'PENDING', new_status: 'CANCELLED', actor: h.identities.citizen.sub, reason: 'Fue una falsa alarma' },
    ]);
    expect(await lastUpdate(id)).toMatchObject({
      estadoAnterior: 'PENDIENTE',
      estadoNuevo: 'CANCELADA',
      usuarioId: h.identities.citizen.sub,
      resolucion: 'Fue una falsa alarma',
      asignadoA: null,
      resueltoAt: null,
    });
  });

  it('también cancela una VALIDATED, y una cancelada ya no admite transiciones (409)', async () => {
    const id = await h.createValidated();

    await h.patch(id, 'cancel', 'citizen').expect(200);

    await h.patch(id, 'cancel', 'citizen').expect(409);
    await h.patch(id, 'assign', 'dispatcher', { officerId: OFFICER_ID }).expect(409);
    expect((await h.emergencyRow(id)).status).toBe('CANCELLED');
    expect(await h.officerStatus(OFFICER_ID)).toBe('disponible');
  });
});

describe('rama discard: el dispatcher descarta una PENDING', () => {
  it('sin motivo responde 400 y no toca nada; con motivo queda DISCARDED, con historial y DESCARTADA', async () => {
    const id = await h.createPending();

    await h.patch(id, 'discard', 'dispatcher', {}).expect(400);
    expect((await h.emergencyRow(id)).status).toBe('PENDING');
    expect(await h.historyOf(id)).toEqual([]);

    const res = await h.patch(id, 'discard', 'dispatcher', { reason: '  Reporte duplicado  ' }).expect(200);

    expect(res.body.data.status).toBe('DISCARDED');
    expect(await h.historyOf(id)).toEqual([
      { previous_status: 'PENDING', new_status: 'DISCARDED', actor: h.identities.dispatcher.sub, reason: 'Reporte duplicado' },
    ]);
    expect(await lastUpdate(id)).toMatchObject({
      estadoAnterior: 'PENDIENTE',
      estadoNuevo: 'DESCARTADA',
      usuarioId: h.identities.dispatcher.sub,
      resolucion: 'Reporte duplicado',
    });
  });

  it('una VALIDATED ya no se puede descartar (409) y queda como estaba', async () => {
    const id = await h.createValidated();

    await h.patch(id, 'discard', 'dispatcher', { reason: 'tarde' }).expect(409);

    expect((await h.emergencyRow(id)).status).toBe('VALIDATED');
  });
});

describe('rama return: el dispatcher devuelve una DISPATCHED para reasignar', () => {
  it('vuelve a VALIDATED, libera al oficial y deja historial y VALIDADA en el outbox', async () => {
    const id = await h.createDispatched(OFFICER_ID);
    expect(await h.officerStatus(OFFICER_ID)).toBe('ocupado');

    const res = await h.patch(id, 'return', 'dispatcher', { reason: 'Oficial equivocado' }).expect(200);

    expect(res.body.data.status).toBe('VALIDATED');
    expect(await h.officerStatus(OFFICER_ID)).toBe('disponible');
    expect((await h.historyOf(id)).pop()).toEqual({
      previous_status: 'DISPATCHED',
      new_status: 'VALIDATED',
      actor: h.identities.dispatcher.sub,
      reason: 'Oficial equivocado',
    });
    expect(await lastUpdate(id)).toMatchObject({
      estadoAnterior: 'DESPACHADA',
      estadoNuevo: 'VALIDADA',
      usuarioId: h.identities.dispatcher.sub,
      asignadoA: null,
      resolucion: 'Oficial equivocado',
    });
  });

  it('después de devolverla se reasigna a otro oficial y el anterior ya no la puede avanzar', async () => {
    const id = await h.createDispatched(OFFICER_ID);
    await h.patch(id, 'return', 'dispatcher', { reason: 'reasignar' }).expect(200);

    const reassigned = await h.patch(id, 'assign', 'dispatcher', { officerId: OTHER_OFFICER_ID }).expect(200);

    expect(reassigned.body.data).toMatchObject({ status: 'DISPATCHED', assignedOfficerId: OTHER_OFFICER_ID });
    expect(await h.officerStatus(OTHER_OFFICER_ID)).toBe('ocupado');
    expect(await h.officerStatus(OFFICER_ID)).toBe('disponible');

    await h.patch(id, 'en-route', 'officer').expect(404);
    await h.patch(id, 'en-route', 'otherOfficer').expect(200);
    expect((await h.emergencyRow(id)).status).toBe('EN_ROUTE');

    const despachadas = updatesOf(await h.outboxOf(id))
      .map((row) => row.payload.data)
      .filter((data) => data.estadoNuevo === 'DESPACHADA');
    expect(despachadas.map((data) => data.asignadoA)).toEqual([OFFICER_ID, OTHER_OFFICER_ID]);
  });

  it('una emergencia que ya salió (EN_ROUTE) no se puede devolver (409) y el oficial sigue ocupado', async () => {
    const id = await h.createDispatched(OFFICER_ID);
    await h.patch(id, 'en-route', 'officer').expect(200);

    await h.patch(id, 'return', 'dispatcher', { reason: 'tarde' }).expect(409);

    expect((await h.emergencyRow(id)).status).toBe('EN_ROUTE');
    expect(await h.officerStatus(OFFICER_ID)).toBe('ocupado');
  });
});

describe('listado del oficial: la prioridad de despacho de lo que tiene asignado', () => {
  it('el oficial la recibe con su motivo y el incidente; el ciudadano dueño, no', async () => {
    const id = await h.createDispatched(OFFICER_ID);

    const asOfficer = expectStatus(
      await h.call('get', '/api/emergencies?scope=active&sortBy=priority&limit=100', 'officer'), 200, 'listado oficial'
    );
    const mine = asOfficer.body.data.find((emergency) => emergency.id === id);
    expect(mine).toMatchObject({ status: 'DISPATCHED', returned: false });
    // Sin incidente ni contexto de zona: la de despacho es la severidad.
    expect(mine.dispatchPriority).toBe(mine.severity);
    expect(mine.effectivePriority).toBe(mine.severity);
    expect(mine).toHaveProperty('priorityContext', null);
    expect(mine).toHaveProperty('incident', null);

    const asCitizen = expectStatus(
      await h.call('get', '/api/emergencies?limit=100', 'citizen'), 200, 'listado ciudadano'
    );
    const own = asCitizen.body.data.find((emergency) => emergency.id === id);
    for (const field of ['incident', 'effectivePriority', 'dispatchPriority', 'priorityContext']) {
      expect(own).not.toHaveProperty(field);
    }
  });
});
