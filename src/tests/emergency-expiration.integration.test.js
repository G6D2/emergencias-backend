// Expiración de emergencias abiertas, contra Postgres real: una emergencia que
// lleva más del plazo de retención sin cambiar de estado pasa a un estado
// terminal y su ubicación se anonimiza en el mismo paso.

const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { startEmergencyExpirationJob } = require('../services/emergency-expiration-job');

const TOPIC = `test.expiracion.${randomUUID().slice(0, 8)}`;
const OFFICER_ID = `of-exp-${randomUUID().slice(0, 8)}`;
const ENV = { TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO: TOPIC };

describe('expiración de emergencias abiertas (integración contra Postgres real)', () => {
  let pool;
  let repository;
  const created = [];
  const eventos = [];

  beforeAll(async () => {
    process.env.LOCATION_ENCRYPTION_KEY =
      process.env.LOCATION_ENCRYPTION_KEY
      || 'flxqyJtbe6+mibyHqK76N6LSnFe0w22hnyDZg9KWIcs=';
    pool = getPool();
    repository = new EmergencyRepository(pool);
    await pool.query(
      `INSERT INTO officers (id, name, badge_number, status) VALUES ($1, 'Oficial de expiración', 'EXP-1', 'disponible')`,
      [OFFICER_ID]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM outbox_events WHERE topic = $1', [TOPIC]);
    await pool.query('DELETE FROM emergency_status_history WHERE emergency_id = ANY($1::uuid[])', [created]);
    await pool.query('DELETE FROM emergencies WHERE id = ANY($1::uuid[])', [created]);
    await pool.query('DELETE FROM contexto_zona WHERE referencia_externa = ANY($1::text[])', [eventos]);
    await pool.query('DELETE FROM officers WHERE id = $1', [OFFICER_ID]);
    await closePool();
  });

  // Obelisco: barrio SAN NICOLAS.
  async function createEmergency(overrides = {}) {
    const id = randomUUID();
    created.push(id);
    await repository.create({
      id,
      userId: 'user-expiracion',
      latitude: -34.6037,
      longitude: -58.3816,
      description: 'Prueba de expiración',
      severity: 'high',
      ...overrides,
    });
    return id;
  }

  // Corre el reloj hacia atrás: la emergencia y todo su historial quedan
  // `hours` horas en el pasado.
  async function age(id, hours) {
    await pool.query(
      `UPDATE emergencies SET created_at = now() - ($2::double precision * interval '1 hour') WHERE id = $1`,
      [id, hours]
    );
    await pool.query(
      `UPDATE emergency_status_history SET created_at = now() - ($2::double precision * interval '1 hour')
       WHERE emergency_id = $1`,
      [id, hours]
    );
  }

  async function advanceTo(id, target) {
    const path = ['VALIDATED', 'DISPATCHED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED'];
    for (const status of path.slice(0, path.indexOf(target) + 1)) {
      if (status === 'DISPATCHED') {
        await repository.assignOfficer(id, { officerId: OFFICER_ID, actor: 'disp-test' });
      } else {
        await repository.updateStatus(id, { newStatus: status, actor: 'test' });
      }
    }
  }

  // Cobertura preventiva de un evento de Espacios, creada hace `edadHoras`.
  // `finEnHoras` es cuándo termina el evento respecto de ahora (negativo: ya
  // terminó); con null no se registra el contexto del evento.
  async function createCoverage({ edadHoras, finEnHoras }) {
    const eventoId = `evento-exp-${randomUUID().slice(0, 8)}`;
    eventos.push(eventoId);
    const id = await createEmergency({
      userId: null, source: 'EXTERNAL', emergencyType: 'PREVENTIVA', status: 'PENDING',
      causaTipo: 'EVENTO_PUBLICO', causaId: eventoId,
    });
    await age(id, edadHoras);
    if (finEnHoras !== null) {
      await pool.query(
        `INSERT INTO contexto_zona
           (tipo, origen, referencia_externa, source_updated_at, vigente_desde, vigente_hasta, latitud, longitud, radio_metros)
         VALUES ('EVENTO_ESPACIO_PUBLICO', 'espacios', $1, now(),
                 now() - interval '300 hours', now() + ($2::double precision * interval '1 hour'),
                 -34.6037, -58.3816, 500)`,
        [eventoId, finEnHoras]
      );
    }
    return id;
  }

  async function row(id) {
    const { rows } = await pool.query(
      `SELECT status, closed_at, latitude, longitude, location_encrypted, location_anonymized_at, barrio,
              assigned_officer_id
       FROM emergencies WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  async function eventsOf(id) {
    const { rows } = await pool.query(
      `SELECT payload FROM outbox_events WHERE topic = $1 AND payload->'data'->>'emergenciaId' = $2 ORDER BY created_at`,
      [TOPIC, id]
    );
    return rows.map((r) => r.payload);
  }

  async function runJob(env = ENV) {
    const job = startEmergencyExpirationJob(repository, { env });
    try {
      return await job.runOnce();
    } finally {
      job.stop();
    }
  }

  it('una PENDING vencida se cancela, queda anonimizada y publica EmergenciaActualizada sin coordenadas', async () => {
    const id = await createEmergency();
    await age(id, 100);

    const result = await runJob();

    expect(result.expired).toContainEqual({ id, previousStatus: 'PENDING', newStatus: 'CANCELLED' });
    const after = await row(id);
    expect(after.status).toBe('CANCELLED');
    expect(after.closed_at).not.toBeNull();
    expect(after.location_encrypted).toBeNull();
    expect(after.latitude).toBeNull();
    expect(after.longitude).toBeNull();
    expect(after.location_anonymized_at).not.toBeNull();
    // El barrio es lo único que se conserva de la ubicación.
    expect(after.barrio).toBe('SAN NICOLAS');

    const history = await repository.findHistoryByEmergencyId(id);
    expect(history.at(-1)).toMatchObject({
      previousStatus: 'PENDING',
      newStatus: 'CANCELLED',
      actor: 'sistema:expiracion',
      reason: 'Expirada: sin cambios de estado en 72 h',
    });

    const events = await eventsOf(id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('EmergenciaActualizada');
    expect(events[0].data).toMatchObject({
      estadoAnterior: 'PENDIENTE',
      estadoNuevo: 'CANCELADA',
      usuarioId: 'sistema:expiracion',
      resolucion: 'Expirada: sin cambios de estado en 72 h',
      barrio: 'SAN NICOLAS',
      latitud: null,
      longitud: null,
      ubicacion: { barrio: 'SAN NICOLAS', latitud: null, longitud: null },
    });
  });

  it('una RESOLVED vencida se cierra y libera al oficial', async () => {
    const id = await createEmergency();
    await advanceTo(id, 'RESOLVED');
    await age(id, 80);

    const result = await runJob();

    expect(result.expired).toContainEqual({ id, previousStatus: 'RESOLVED', newStatus: 'CLOSED' });
    expect((await row(id)).status).toBe('CLOSED');
    const officer = await pool.query('SELECT status FROM officers WHERE id = $1', [OFFICER_ID]);
    expect(officer.rows[0].status).toBe('disponible');
    expect((await eventsOf(id)).at(-1).data).toMatchObject({ estadoAnterior: 'RESUELTA', estadoNuevo: 'CERRADA' });
  });

  it('una despachada vencida se cancela aunque los endpoints no tengan esa transición, y libera al oficial', async () => {
    const id = await createEmergency();
    await advanceTo(id, 'EN_ROUTE');
    expect((await pool.query('SELECT status FROM officers WHERE id = $1', [OFFICER_ID])).rows[0].status).toBe('ocupado');
    await age(id, 73);

    const result = await runJob();

    expect(result.expired).toContainEqual({ id, previousStatus: 'EN_ROUTE', newStatus: 'CANCELLED' });
    const after = await row(id);
    expect(after.status).toBe('CANCELLED');
    expect(after.location_anonymized_at).not.toBeNull();
    expect((await pool.query('SELECT status FROM officers WHERE id = $1', [OFFICER_ID])).rows[0].status).toBe('disponible');
  });

  it('no toca una emergencia reciente ni una vieja que cambió de estado hace poco', async () => {
    const reciente = await createEmergency();
    const viejaConActividad = await createEmergency();
    await pool.query(`UPDATE emergencies SET created_at = now() - interval '200 hours' WHERE id = $1`, [viejaConActividad]);
    await repository.updateStatus(viejaConActividad, { newStatus: 'VALIDATED', actor: 'disp-test' });

    const result = await runJob();

    const ids = result.expired.map((e) => e.id);
    expect(ids).not.toContain(reciente);
    expect(ids).not.toContain(viejaConActividad);
    expect((await row(reciente)).status).toBe('PENDING');
    const still = await row(viejaConActividad);
    expect(still.status).toBe('VALIDATED');
    expect(still.location_encrypted).not.toBeNull();
  });

  it('una cobertura preventiva no expira hasta pasado el plazo desde el fin de su evento', async () => {
    const eventoFuturo = await createCoverage({ edadHoras: 100, finEnHoras: 48 });
    const terminoHacePoco = await createCoverage({ edadHoras: 100, finEnHoras: -10 });
    const terminoHaceMucho = await createCoverage({ edadHoras: 100, finEnHoras: -80 });
    const sinContexto = await createCoverage({ edadHoras: 100, finEnHoras: null });

    await runJob();

    expect((await row(eventoFuturo)).status).toBe('PENDING');
    expect((await row(terminoHacePoco)).status).toBe('PENDING');
    expect((await row(terminoHaceMucho)).status).toBe('CANCELLED');
    expect((await row(sinContexto)).status).toBe('CANCELLED');
  });

  it('justo antes del plazo no expira; pasado el plazo, sí', async () => {
    const id = await createEmergency();
    await age(id, 71);
    expect((await runJob()).expired.map((e) => e.id)).not.toContain(id);

    await age(id, 73);
    expect((await runJob()).expired.map((e) => e.id)).toContain(id);
  });

  it('una emergencia ya terminada no se toca, y correr dos veces no expira dos veces', async () => {
    const cerrada = await createEmergency();
    await repository.updateStatus(cerrada, { newStatus: 'DISCARDED', actor: 'disp-test', reason: 'falsa alarma' });
    await age(cerrada, 500);
    const abierta = await createEmergency();
    await age(abierta, 100);

    const first = await runJob();
    const second = await runJob();

    expect(first.expired.map((e) => e.id)).toContain(abierta);
    expect(first.expired.map((e) => e.id)).not.toContain(cerrada);
    expect(second.expired.map((e) => e.id)).not.toContain(abierta);
    expect((await row(cerrada)).status).toBe('DISCARDED');
    expect(await eventsOf(abierta)).toHaveLength(1);
    expect((await repository.findHistoryByEmergencyId(abierta)).filter((h) => h.newStatus === 'CANCELLED')).toHaveLength(1);
  });

  it('respeta EMERGENCY_EXPIRATION_HOURS y queda apagado con EMERGENCY_EXPIRATION_ENABLED=false', async () => {
    const id = await createEmergency();
    await age(id, 10);

    const off = startEmergencyExpirationJob(repository, { env: { ...ENV, EMERGENCY_EXPIRATION_ENABLED: 'false' } });
    expect(off.runOnce).toBeUndefined();
    off.stop();
    expect((await runJob()).expired.map((e) => e.id)).not.toContain(id);

    const result = await runJob({ ...ENV, EMERGENCY_EXPIRATION_HOURS: '6' });

    expect(result.expired.map((e) => e.id)).toContain(id);
    expect((await repository.findHistoryByEmergencyId(id)).at(-1).reason).toBe('Expirada: sin cambios de estado en 6 h');
  });
});
