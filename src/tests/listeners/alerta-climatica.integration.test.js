// Alerta climática de punta a punta (issues #80 y #88): una
// CriticidadClimaticaConfirmada de Espacios deja un contexto de zona por cada
// punto de la alerta y, con nivel ALTA o CRITICA, una emergencia PREVENTIVA
// con causa EVENTO_CLIMATICO. La CriticidadClimaticaFinalizada da de baja los
// contextos y cancela la emergencia que nadie despachó.
//
// Kafka no corre: se llama a EventListener.onMessage() con el mensaje
// serializado. Postgres y la app HTTP son reales.

const { randomUUID } = require('crypto');
const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
const { ContextoZonaRepository, mapContextoZona } = require('../../repositories/contexto-zona.repository');
const { OutcomeFactory } = require('../../listeners/outcome-factory');
const {
  CriticidadClimaticaConfirmadaListener,
  CriticidadClimaticaFinalizadaListener,
} = require('../../listeners/alerta-climatica');
const {
  CREAR_EMERGENCIA_CLIMATICA,
  CANCELAR_EMERGENCIA_CLIMATICA,
  createCrearEmergenciaClimaticaHandler,
  createCancelarEmergenciaClimaticaHandler,
} = require('../../listeners/alerta-climatica/handlers/emergencia-climatica.handler');
const {
  REGISTRAR_CONTEXTOS_CLIMATICOS,
  DAR_DE_BAJA_CONTEXTOS_CLIMATICOS,
  createRegistrarContextosClimaticosHandler,
  createDarDeBajaContextosClimaticosHandler,
} = require('../../listeners/alerta-climatica/handlers/contextos-climaticos.handler');
const { createLocationCrypto } = require('../../security/location-crypto');
const { createLifecycleHarness } = require('../helpers/emergency-lifecycle');

const CREATED_TOPIC = 'test.clima.emergencias.creada';
const UPDATED_TOPIC = 'test.clima.emergencias.actualizada';

// Puntos de la alerta: Obelisco y Belgrano. CERCA queda a ~1,1 km del
// Obelisco (dentro del radio de clima de 2 km); el Rosedal, a más de 3 km de
// los dos.
const OBELISCO = { latitude: -34.6037, longitude: -58.3816 };
const BELGRANO = { latitude: -34.5631, longitude: -58.4584 };
const CERCA = { latitude: -34.6100, longitude: -58.3900 };
const ROSEDAL = { latitude: -34.5711, longitude: -58.4167 };

const HORA = 60 * 60 * 1000;

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

let pool;
let h;
let confirmada;
let finalizada;
const alertaIds = [];
const eventIds = [];

function confirmacion(overrides = {}) {
  const alertaId = overrides.alertaId || randomUUID();
  const eventId = randomUUID();
  alertaIds.push(alertaId);
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.CriticidadClimaticaConfirmada', source: 'grupo7' },
    data: {
      alertaId,
      nivelCriticidad: 'ALTA',
      fenomeno: 'TORMENTA_FUERTE',
      ubicaciones: [
        { latitud: OBELISCO.latitude, longitud: OBELISCO.longitude },
        { latitud: BELGRANO.latitude, longitud: BELGRANO.longitude },
      ],
      barrios: ['SAN NICOLAS', 'BELGRANO'],
      vigenciaDesde: Date.now() - HORA,
      vigenciaHasta: Date.now() + 2 * HORA,
      actorSub: 'admin-1',
      ...overrides,
    },
  };
}

function finalizacion(alertaId) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.CriticidadClimaticaFinalizada', source: 'grupo7' },
    data: { alertaId, finalizadaEn: Date.now(), actorSub: 'admin-1' },
  };
}

async function contextosDe(alertaId) {
  const { rows } = await pool.query(
    `SELECT * FROM contexto_zona
     WHERE tipo = 'ALERTA_CLIMATICA' AND origen = 'espacios'
       AND left(referencia_externa, length($1)) = $1
     ORDER BY referencia_externa`,
    [alertaId]
  );
  return rows.map(mapContextoZona);
}

async function emergenciasDe(alertaId) {
  const { rows } = await pool.query(
    "SELECT * FROM emergencies WHERE causa_tipo = 'EVENTO_CLIMATICO' AND causa_id = $1",
    [alertaId]
  );
  return rows;
}

beforeAll(async () => {
  pool = getPool();
  h = await createLifecycleHarness(pool);
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  const contextoZonaRepository = new ContextoZonaRepository(pool);

  const factory = new OutcomeFactory(pool, { dedupRepo: new EventosProcesadosRepository(pool) });
  factory.register(CREAR_EMERGENCIA_CLIMATICA, createCrearEmergenciaClimaticaHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  factory.register(CANCELAR_EMERGENCIA_CLIMATICA, createCancelarEmergenciaClimaticaHandler({ emergencyRepository, topic: UPDATED_TOPIC }));
  factory.register(REGISTRAR_CONTEXTOS_CLIMATICOS, createRegistrarContextosClimaticosHandler({ contextoZonaRepository }));
  factory.register(DAR_DE_BAJA_CONTEXTOS_CLIMATICOS, createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository }));

  confirmada = new CriticidadClimaticaConfirmadaListener(fakeKafka(), { factory });
  finalizada = new CriticidadClimaticaFinalizadaListener(fakeKafka(), { factory });
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM contexto_zona WHERE tipo = 'ALERTA_CLIMATICA'
       AND split_part(referencia_externa, '#', 1) = ANY($1::text[])`,
    [alertaIds]
  );
  await pool.query('DELETE FROM eventos_procesados WHERE event_id = ANY($1::uuid[])', [eventIds]);
  await pool.query(
    "DELETE FROM emergencies WHERE causa_tipo = 'EVENTO_CLIMATICO' AND causa_id = ANY($1::text[])",
    [alertaIds]
  );
  await pool.query('DELETE FROM outbox_events WHERE topic IN ($1, $2)', [CREATED_TOPIC, UPDATED_TOPIC]);
  await h.cleanup();
  await pool.end();
});

describe('alerta climática (integration)', () => {
  it('la confirmación ALTA deja un contexto por punto y una emergencia climática', async () => {
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    const { alertaId } = evento.data;

    const contextos = await contextosDe(alertaId);
    expect(contextos.map((c) => c.referenciaExterna)).toEqual([`${alertaId}#0`, `${alertaId}#1`]);
    expect(contextos[0]).toMatchObject({
      latitud: OBELISCO.latitude,
      longitud: OBELISCO.longitude,
      radioMetros: 2000,
      causationId: evento.metadata.eventId,
      dadoDeBajaEn: null,
    });
    expect(contextos[0].vigenteHasta.getTime()).toBe(evento.data.vigenciaHasta);

    const [emergencia] = await emergenciasDe(alertaId);
    expect(emergencia).toMatchObject({
      emergency_type: 'PREVENTIVA',
      severity: 'high',
      status: 'PENDING',
      source: 'EXTERNAL',
      requires_manual_validation: false,
    });

    const { rows } = await pool.query(
      "SELECT payload FROM outbox_events WHERE topic = $1 AND payload->'data'->>'emergenciaId' = $2",
      [CREATED_TOPIC, emergencia.id]
    );
    expect(rows[0].payload.data).toMatchObject({
      causaTipo: 'EVENTO_CLIMATICO',
      causaId: alertaId,
      prioridad: 'ALTA',
      prioridadOriginal: 'ALTA',
    });

    // La emergencia de la alerta no queda elevada por sus propios contextos.
    const vinculos = await pool.query('SELECT 1 FROM emergencia_contexto_zona WHERE emergency_id = $1', [emergencia.id]);
    expect(vinculos.rowCount).toBe(0);
  });

  it('una reentrega con otro eventId no duplica contextos ni emergencia', async () => {
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    const otra = confirmacion({ alertaId: evento.data.alertaId });
    await confirmada.onMessage(buildMessage(otra));

    expect(await contextosDe(evento.data.alertaId)).toHaveLength(2);
    expect(await emergenciasDe(evento.data.alertaId)).toHaveLength(1);
  });

  it('MEDIA deja contextos pero no crea emergencia', async () => {
    const evento = confirmacion({ nivelCriticidad: 'MEDIA' });
    await confirmada.onMessage(buildMessage(evento));
    expect(await contextosDe(evento.data.alertaId)).toHaveLength(2);
    expect(await emergenciasDe(evento.data.alertaId)).toHaveLength(0);
  });

  it('una emergencia nueva dentro del radio de un punto sube un nivel; fuera, no', async () => {
    const evento = confirmacion({ nivelCriticidad: 'BAJA' });
    await confirmada.onMessage(buildMessage(evento));

    const dentro = await h.createPending({ emergencyType: 'MEDICA', location: CERCA });
    const lejos = await h.createPending({ emergencyType: 'MEDICA', location: ROSEDAL });

    const resDentro = await h.call('get', `/api/emergencies/${dentro}`, 'dispatcher');
    expect(resDentro.body.data.dispatchPriority).toBe('critical');
    // Otras alertas de este archivo siguen en curso sobre el Obelisco: se
    // muestra una sola, así que solo se mira el tipo.
    expect(resDentro.body.data.priorityContext).toMatchObject({ tipo: 'ALERTA_CLIMATICA' });

    const resLejos = await h.call('get', `/api/emergencies/${lejos}`, 'dispatcher');
    expect(resLejos.body.data.dispatchPriority).toBe('high');
  });

  it('la finalización da de baja los contextos y cancela la emergencia sin despachar', async () => {
    const evento = confirmacion({ nivelCriticidad: 'CRITICA' });
    await confirmada.onMessage(buildMessage(evento));
    await finalizada.onMessage(buildMessage(finalizacion(evento.data.alertaId)));

    const contextos = await contextosDe(evento.data.alertaId);
    expect(contextos.length).toBe(3); // los dos puntos y la marca de la alerta
    contextos.forEach((c) => expect(c.dadoDeBajaEn).not.toBeNull());

    const [emergencia] = await emergenciasDe(evento.data.alertaId);
    expect(emergencia.status).toBe('CANCELLED');
  });

  it('si la finalización llega antes, la confirmación tardía no crea contextos', async () => {
    const alertaId = randomUUID();
    await finalizada.onMessage(buildMessage(finalizacion(alertaId)));
    await confirmada.onMessage(buildMessage(confirmacion({ alertaId, nivelCriticidad: 'MEDIA' })));

    const contextos = await contextosDe(alertaId);
    expect(contextos.map((c) => c.referenciaExterna)).toEqual([alertaId]);
    expect(contextos[0].dadoDeBajaEn).not.toBeNull();
  });
});
