// Reclamo que desencadena una intervención, de punta a punta (issue #37 del
// board): un ReclamoCreado de tránsito sobre una ciclovía crea una emergencia
// externa TRANSITO con causa RECLAMO, y un ReclamoActualizado en estado final
// la cancela si todavía no fue despachada.
//
// Es el camino directo (plan B del caso): corre con el disparador en `ambos`.
// El camino de diseño, por la EmergenciaSolicitada de Movilidad, está en
// emergencia-solicitada.integration.test.js.
//
// Kafka no corre: se llama a EventListener.onMessage() con el mensaje
// serializado. Postgres es real (levantado por global-setup.js).

const { randomUUID } = require('crypto');
const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
const { OutcomeFactory } = require('../../listeners/outcome-factory');
const { ReclamoCreadoListener, ReclamoActualizadoListener } = require('../../listeners/reclamo-intervencion');
const { CREAR_INTERVENCION, createCrearIntervencionHandler } = require('../../listeners/reclamo-intervencion/handlers/crear-intervencion.handler');
const { CERRAR_INTERVENCION, createCerrarIntervencionHandler } = require('../../listeners/reclamo-intervencion/handlers/cerrar-intervencion.handler');
const { createLocationCrypto } = require('../../security/location-crypto');

const CREATED_TOPIC = 'test.reclamo.emergencias.creada';
const UPDATED_TOPIC = 'test.reclamo.emergencias.actualizada';

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

let pool;
let emergencyRepository;
let creado;
let actualizado;
const reclamoIds = [];
const eventIds = [];

// Primera prueba acordada en el grupo del caso: reclamo en el Obelisco.
function reclamoCreado(overrides = {}) {
  const reclamoId = overrides.reclamoId || `rec-${randomUUID()}`;
  const eventId = randomUUID();
  reclamoIds.push(reclamoId);
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.reclamos.ReclamoCreado', source: 'grupo4' },
    data: {
      reclamoId,
      ciudadanoId: 'vec-9',
      canal: 'APP',
      titulo: 'Auto estacionado en la bicisenda',
      descripcion: 'Hace dos horas que está ahí',
      categoria: 'TRANSITO',
      prioridad: 'ALTA',
      estado: 'RECIBIDO',
      origenClasificacion: 'CIUDADANO',
      direccion: 'Av. Corrientes 1234',
      barrio: 'San Nicolás',
      latitud: -34.6037,
      longitud: -58.3816,
      objetoAfectado: 'CICLOVIA',
      afectaCirculacion: true,
      correlationId: randomUUID(),
      createdAt: Date.now(),
      ...overrides,
    },
  };
}

function reclamoActualizado(reclamoId, estadoNuevo, estadoAnterior = 'EN_PROCESO') {
  const eventId = randomUUID();
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.reclamos.ReclamoActualizado', source: 'grupo4' },
    data: { reclamoId, ciudadanoId: 'vec-9', estadoAnterior, estadoNuevo, cambiadoPor: 'eda:espacios', updatedAt: Date.now() },
  };
}

async function intervenciones(reclamoId) {
  const { rows } = await pool.query(
    `SELECT id, status, emergency_type, severity, source, user_id, causa_tipo, causa_id, barrio,
            requires_manual_validation, correlation_id
     FROM emergencies WHERE causa_tipo = 'RECLAMO' AND causa_id = $1`,
    [reclamoId]
  );
  return rows;
}

async function eventosDe(emergencyId, topic) {
  const { rows } = await pool.query(
    `SELECT payload FROM outbox_events WHERE topic = $1 AND payload->'data'->>'emergenciaId' = $2 ORDER BY created_at`,
    [topic, emergencyId]
  );
  return rows.map((row) => row.payload);
}

beforeAll(() => {
  pool = getPool();
  emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  const factory = new OutcomeFactory(pool, { dedupRepo: new EventosProcesadosRepository(pool) });
  factory.register(CREAR_INTERVENCION, createCrearIntervencionHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  factory.register(CERRAR_INTERVENCION, createCerrarIntervencionHandler({ emergencyRepository, topic: UPDATED_TOPIC }));
  creado = new ReclamoCreadoListener(fakeKafka(), { factory, disparador: 'ambos' });
  actualizado = new ReclamoActualizadoListener(fakeKafka(), { factory });
});

afterAll(async () => {
  await pool.query('DELETE FROM eventos_procesados WHERE event_id = ANY($1::uuid[])', [eventIds]);
  await pool.query(
    `DELETE FROM emergency_status_history WHERE emergency_id IN
       (SELECT id FROM emergencies WHERE causa_tipo = 'RECLAMO' AND causa_id = ANY($1))`,
    [reclamoIds]
  );
  await pool.query("DELETE FROM emergencies WHERE causa_tipo = 'RECLAMO' AND causa_id = ANY($1)", [reclamoIds]);
  await pool.query('DELETE FROM outbox_events WHERE topic IN ($1, $2)', [CREATED_TOPIC, UPDATED_TOPIC]);
  await pool.end();
});

describe('reclamo de ciclovía → intervención', () => {
  it('crea una emergencia TRANSITO externa y deja EmergenciaCreada en el outbox', async () => {
    const event = reclamoCreado();
    await creado.onMessage(buildMessage(event));

    const rows = await intervenciones(event.data.reclamoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      emergency_type: 'TRANSITO',
      severity: 'high',
      source: 'EXTERNAL',
      user_id: null,
      causa_tipo: 'RECLAMO',
      causa_id: event.data.reclamoId,
      barrio: 'SAN NICOLAS',
      requires_manual_validation: false,
      correlation_id: event.data.correlationId,
    });

    const [created] = await eventosDe(rows[0].id, CREATED_TOPIC);
    expect(created.type).toBe('EmergenciaCreada');
    expect(created.data).toMatchObject({
      categoria: 'TRANSITO',
      prioridad: 'ALTA',
      estado: 'PENDIENTE',
      barrio: 'SAN NICOLAS',
      latitud: -34.604,
      longitud: -58.382,
      afectaCirculacion: true,
      causaTipo: 'RECLAMO',
      causaId: event.data.reclamoId,
      ciudadanoId: null,
    });
    // El texto libre del vecino no vuelve al bus.
    expect(JSON.stringify(created)).not.toContain('bicisenda');
  });

  it('la reentrega y la republicación del mismo reclamo no crean otra', async () => {
    const event = reclamoCreado();
    await creado.onMessage(buildMessage(event));
    await creado.onMessage(buildMessage(event));
    await creado.onMessage(buildMessage(reclamoCreado({ reclamoId: event.data.reclamoId })));

    expect(await intervenciones(event.data.reclamoId)).toHaveLength(1);
  });

  it('otros reclamos no crean nada', async () => {
    const bache = reclamoCreado({ categoria: 'BACHES' });
    const vereda = reclamoCreado({ objetoAfectado: 'VEREDA' });
    const sinObjeto = reclamoCreado({ objetoAfectado: null });
    const yaResuelto = reclamoCreado({ estado: 'RESUELTO' });
    for (const event of [bache, vereda, sinObjeto, yaResuelto]) {
      await creado.onMessage(buildMessage(event));
      expect(await intervenciones(event.data.reclamoId)).toHaveLength(0);
    }
  });

  it('sin coordenadas queda para validación manual y resuelve el barrio por el texto', async () => {
    const event = reclamoCreado({ latitud: null, longitud: null, correlationId: 'req-7c9e6679' });
    await creado.onMessage(buildMessage(event));

    const [row] = await intervenciones(event.data.reclamoId);
    expect(row).toMatchObject({ requires_manual_validation: true, barrio: 'SAN NICOLAS' });
    // El correlationId se conserva aunque no sea UUID (#77) y sale en EmergenciaCreada.
    expect(row.correlation_id).toBe('req-7c9e6679');
    const [created] = await eventosDe(row.id, CREATED_TOPIC);
    expect(created.correlationId).toBe('req-7c9e6679');
    expect(created.data.correlationId).toBe('req-7c9e6679');
  });

  it('el reclamo RESUELTO cancela la intervención pendiente y publica EmergenciaActualizada', async () => {
    const event = reclamoCreado();
    await creado.onMessage(buildMessage(event));
    const [{ id }] = await intervenciones(event.data.reclamoId);

    await actualizado.onMessage(buildMessage(reclamoActualizado(event.data.reclamoId, 'EN_PROCESO', 'ASIGNADO')));
    expect((await intervenciones(event.data.reclamoId))[0].status).toBe('PENDING');

    await actualizado.onMessage(buildMessage(reclamoActualizado(event.data.reclamoId, 'RESUELTO')));
    expect((await intervenciones(event.data.reclamoId))[0].status).toBe('CANCELLED');

    const updates = await eventosDe(id, UPDATED_TOPIC);
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({
      estadoAnterior: 'PENDIENTE',
      estadoNuevo: 'CANCELADA',
      usuarioId: 'eda:reclamos',
      resolucion: 'Reclamo RESUELTO',
    });

    // CERRADO llega después (a los 7 días o a mano): ya no hay nada que cancelar.
    await actualizado.onMessage(buildMessage(reclamoActualizado(event.data.reclamoId, 'CERRADO', 'RESUELTO')));
    expect(await eventosDe(id, UPDATED_TOPIC)).toHaveLength(1);
  });

  it('si el agente ya fue despachado, el cierre del reclamo no la toca', async () => {
    const event = reclamoCreado();
    await creado.onMessage(buildMessage(event));
    const [{ id }] = await intervenciones(event.data.reclamoId);
    await emergencyRepository.updateStatus(id, { newStatus: 'VALIDATED', actor: 'disp-test' });
    await emergencyRepository.updateStatus(id, { newStatus: 'DISPATCHED', actor: 'disp-test' });

    await actualizado.onMessage(buildMessage(reclamoActualizado(event.data.reclamoId, 'RECHAZADO')));

    expect((await intervenciones(event.data.reclamoId))[0].status).toBe('DISPATCHED');
  });

  it('el cierre de un reclamo sin intervención no hace nada', async () => {
    const reclamoId = `rec-${randomUUID()}`;
    await actualizado.onMessage(buildMessage(reclamoActualizado(reclamoId, 'CERRADO')));
    expect(await intervenciones(reclamoId)).toHaveLength(0);
  });
});
