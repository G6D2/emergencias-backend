// Reclamos → Movilidad → Emergencias, de punta a punta: la EmergenciaSolicitada
// de Movilidad crea la intervención del reclamo de ciclovía, y
// RECLAMO_INTERVENCION_DISPARADOR decide si el ReclamoCreado directo también
// puede crearla (plan B). Nunca hay más de una intervención por reclamo, ni
// con los dos listeners procesando el mismo reclamo a la vez.
//
// Kafka no corre: se llama a EventListener.onMessage() con el mensaje
// serializado. Postgres es real (levantado por global-setup.js).

const { randomUUID } = require('crypto');
const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
const { OutcomeFactory } = require('../../listeners/outcome-factory');
const {
  EmergenciaSolicitadaListener,
  ReclamoCreadoListener,
  ReclamoActualizadoListener,
} = require('../../listeners/reclamo-intervencion');
const { CREAR_INTERVENCION, createCrearIntervencionHandler } = require('../../listeners/reclamo-intervencion/handlers/crear-intervencion.handler');
const { CERRAR_INTERVENCION, createCerrarIntervencionHandler } = require('../../listeners/reclamo-intervencion/handlers/cerrar-intervencion.handler');
const { createLocationCrypto } = require('../../security/location-crypto');

const CREATED_TOPIC = 'test.solicitada.emergencias.creada';
const UPDATED_TOPIC = 'test.solicitada.emergencias.actualizada';

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

let pool;
let dedup;
const reclamoIds = [];
const eventIds = [];

function nuevoReclamoId() {
  const reclamoId = randomUUID();
  reclamoIds.push(reclamoId);
  return reclamoId;
}

function sobre(eventType, source, data) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  return { metadata: { eventId, eventType, source }, data };
}

// Forma del EmergenciaSolicitada del PR #40 de Movilidad.
function emergenciaSolicitada(reclamoId, overrides = {}) {
  return sobre('com.citypass.movilidad.EmergenciaSolicitada', 'grupo3', {
    reclamoId,
    correlationId: randomUUID(),
    origen: 'MOVILIDAD',
    tipoEmergencia: 'OBSTRUCCION_CICLOVIA_CRITICA',
    prioridad: 'CRITICA',
    descripcion: 'Obstrucción crítica de ciclovía',
    direccion: 'Av. Corrientes 1234',
    latitud: -34.6037,
    longitud: -58.3816,
    solicitadoAt: Date.now(),
    ...overrides,
  });
}

function reclamoCreado(reclamoId, overrides = {}) {
  return sobre('com.citypass.reclamos.ReclamoCreado', 'grupo4', {
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
  });
}

function reclamoActualizado(reclamoId, estadoNuevo) {
  return sobre('com.citypass.reclamos.ReclamoActualizado', 'grupo4', {
    reclamoId, ciudadanoId: 'vec-9', estadoAnterior: 'EN_PROCESO', estadoNuevo, cambiadoPor: 'eda:espacios', updatedAt: Date.now(),
  });
}

async function intervenciones(reclamoId) {
  const { rows } = await pool.query(
    `SELECT id, status, emergency_type, severity, source, causa_tipo, causa_id, barrio, description, correlation_id
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

// Los tres listeners del caso sobre un mismo OutcomeFactory, con el disparador
// que se pida. `repository` permite inyectar uno instrumentado (carrera).
function listenersCon(disparador, repository) {
  const emergencyRepository = repository || new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  const factory = new OutcomeFactory(pool, { dedupRepo: dedup });
  factory.register(CREAR_INTERVENCION, createCrearIntervencionHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  factory.register(CERRAR_INTERVENCION, createCerrarIntervencionHandler({ emergencyRepository, topic: UPDATED_TOPIC }));
  const options = disparador === undefined ? { factory } : { factory, disparador };
  return {
    emergencyRepository,
    solicitada: new EmergenciaSolicitadaListener(fakeKafka(), options),
    creado: new ReclamoCreadoListener(fakeKafka(), options),
    actualizado: new ReclamoActualizadoListener(fakeKafka(), options),
  };
}

beforeAll(() => {
  pool = getPool();
  dedup = new EventosProcesadosRepository(pool);
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

describe('EmergenciaSolicitada de Movilidad → intervención', () => {
  const env = process.env.RECLAMO_INTERVENCION_DISPARADOR;
  beforeEach(() => { delete process.env.RECLAMO_INTERVENCION_DISPARADOR; });
  afterAll(() => {
    if (env === undefined) delete process.env.RECLAMO_INTERVENCION_DISPARADOR;
    else process.env.RECLAMO_INTERVENCION_DISPARADOR = env;
  });

  it('por defecto la solicitud de Movilidad crea la intervención y deja EmergenciaCreada en el outbox', async () => {
    const { solicitada } = listenersCon();
    const reclamoId = nuevoReclamoId();
    const event = emergenciaSolicitada(reclamoId);

    await solicitada.onMessage(buildMessage(event));

    const rows = await intervenciones(reclamoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      emergency_type: 'TRANSITO',
      severity: 'critical',
      source: 'EXTERNAL',
      causa_tipo: 'RECLAMO',
      causa_id: reclamoId,
      barrio: 'SAN NICOLAS',
      description: 'Reclamo por ciclovía obstruida — Obstrucción crítica de ciclovía',
      correlation_id: event.data.correlationId,
    });
    const [created] = await eventosDe(rows[0].id, CREATED_TOPIC);
    expect(created.data).toMatchObject({
      categoria: 'TRANSITO',
      prioridad: 'CRITICA',
      afectaCirculacion: true,
      causaTipo: 'RECLAMO',
      causaId: reclamoId,
      latitud: -34.604,
      longitud: -58.382,
      ciudadanoId: null,
    });
  });

  it('por defecto un ReclamoCreado solo no crea nada (lo decide Movilidad)', async () => {
    const { creado } = listenersCon();
    const reclamoId = nuevoReclamoId();

    await creado.onMessage(buildMessage(reclamoCreado(reclamoId)));

    expect(await intervenciones(reclamoId)).toHaveLength(0);
  });

  it('la reentrega y una segunda solicitud del mismo reclamo no crean otra', async () => {
    const { solicitada } = listenersCon();
    const reclamoId = nuevoReclamoId();
    const event = emergenciaSolicitada(reclamoId);

    await solicitada.onMessage(buildMessage(event));
    await solicitada.onMessage(buildMessage(event));
    await solicitada.onMessage(buildMessage(emergenciaSolicitada(reclamoId, { prioridad: 'ALTA' })));

    const rows = await intervenciones(reclamoId);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('critical');
  });

  it('con `ambos`: reclamo y después solicitud dejan una sola, y al revés también', async () => {
    const { solicitada, creado } = listenersCon('ambos');

    const primeroReclamo = nuevoReclamoId();
    await creado.onMessage(buildMessage(reclamoCreado(primeroReclamo)));
    await solicitada.onMessage(buildMessage(emergenciaSolicitada(primeroReclamo)));
    const a = await intervenciones(primeroReclamo);
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe('high'); // la creó el reclamo, con su prioridad

    const primeroMovilidad = nuevoReclamoId();
    await solicitada.onMessage(buildMessage(emergenciaSolicitada(primeroMovilidad)));
    await creado.onMessage(buildMessage(reclamoCreado(primeroMovilidad)));
    const b = await intervenciones(primeroMovilidad);
    expect(b).toHaveLength(1);
    expect(b[0].severity).toBe('critical'); // la creó Movilidad
  });

  it('con `reclamo` la solicitud de Movilidad no crea nada y el reclamo directo sí', async () => {
    const { solicitada, creado } = listenersCon('reclamo');
    const reclamoId = nuevoReclamoId();

    await solicitada.onMessage(buildMessage(emergenciaSolicitada(reclamoId)));
    expect(await intervenciones(reclamoId)).toHaveLength(0);

    await creado.onMessage(buildMessage(reclamoCreado(reclamoId)));
    expect(await intervenciones(reclamoId)).toHaveLength(1);
  });

  it('el cierre del reclamo cancela una intervención que pidió Movilidad', async () => {
    const { solicitada, actualizado } = listenersCon();
    const reclamoId = nuevoReclamoId();
    await solicitada.onMessage(buildMessage(emergenciaSolicitada(reclamoId)));
    const [{ id }] = await intervenciones(reclamoId);

    await actualizado.onMessage(buildMessage(reclamoActualizado(reclamoId, 'RESUELTO')));

    expect((await intervenciones(reclamoId))[0].status).toBe('CANCELLED');
    const updates = await eventosDe(id, UPDATED_TOPIC);
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ estadoNuevo: 'CANCELADA', usuarioId: 'eda:reclamos', resolucion: 'Reclamo RESUELTO' });
  });

  it('sin coordenadas queda para validación manual; prioridad y correlationId raros no rompen', async () => {
    const { solicitada } = listenersCon();
    const reclamoId = nuevoReclamoId();

    await solicitada.onMessage(buildMessage(emergenciaSolicitada(reclamoId, {
      latitud: null, longitud: null, prioridad: 'URGENTISIMA', correlationId: 'req-7c9e6679', descripcion: '',
    })));

    const [row] = await intervenciones(reclamoId);
    expect(row).toMatchObject({ severity: 'medium', description: 'Reclamo por ciclovía obstruida', barrio: null });
    // El correlationId de Movilidad se conserva aunque no sea UUID (#77).
    expect(row.correlation_id).toBe('req-7c9e6679');
  });

  it('un correlationId con caracteres de control no se guarda: usa el id propio', async () => {
    const { solicitada } = listenersCon();
    const reclamoId = nuevoReclamoId();

    await solicitada.onMessage(buildMessage(emergenciaSolicitada(reclamoId, { correlationId: 'req-1\r\nX-Falso: 1' })));

    const [row] = await intervenciones(reclamoId);
    expect(row.correlation_id).toBe(row.id);
  });

  it('los dos listeners procesando el mismo reclamo a la vez dejan UNA intervención y los dos eventos procesados', async () => {
    // Barrera: los dos handlers pasan el findByCausa (sin ver nada) antes de
    // que cualquiera inserte. Es la carrera real entre consumer groups.
    const repository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
    const original = repository.findByCausa.bind(repository);
    let llegaron = 0;
    let abrir;
    const barrera = new Promise((resolve) => { abrir = resolve; });
    repository.findByCausa = async (...args) => {
      const rows = await original(...args);
      llegaron += 1;
      if (llegaron <= 2) {
        if (llegaron === 2) abrir();
        await barrera;
      }
      return rows;
    };
    const { solicitada, creado } = listenersCon('ambos', repository);
    const reclamoId = nuevoReclamoId();
    const deMovilidad = emergenciaSolicitada(reclamoId);
    const deReclamos = reclamoCreado(reclamoId);

    const results = await Promise.allSettled([
      solicitada.onMessage(buildMessage(deMovilidad)),
      creado.onMessage(buildMessage(deReclamos)),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await intervenciones(reclamoId);
    expect(rows).toHaveLength(1);
    expect(await eventosDe(rows[0].id, CREATED_TOPIC)).toHaveLength(1);
    const procesados = await pool.query(
      'SELECT status FROM eventos_procesados WHERE event_id = ANY($1::uuid[])',
      [[deMovilidad.metadata.eventId, deReclamos.metadata.eventId]]
    );
    expect(procesados.rows.map((r) => r.status).sort()).toEqual(['PROCESSED', 'PROCESSED']);
  });
});
