// Alerta climática de punta a punta (issues #80 y #88; ADR "Responder a las
// alertas climáticas de Espacios"): una CriticidadClimaticaConfirmada ALTA o
// CRITICA de Espacios deja un contexto de zona por cada punto de la alerta,
// con el radio del nivel (ALTA 500 m, CRITICA 1000 m), y una emergencia
// PREVENTIVA con causa EVENTO_CLIMATICO. BAJA y MEDIA no generan nada. La
// CriticidadClimaticaFinalizada da de baja los contextos y cancela la
// emergencia que nadie despachó, aunque llegue antes o a la vez que la
// confirmación.
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
const { grupoDeLaAlerta } = require('../../domain/alerta-climatica');
const { createLocationCrypto } = require('../../security/location-crypto');
const { createLifecycleHarness } = require('../helpers/emergency-lifecycle');

const CREATED_TOPIC = 'test.clima.emergencias.creada';
const UPDATED_TOPIC = 'test.clima.emergencias.actualizada';

// Puntos de las alertas que comparten el archivo: Obelisco y Belgrano.
const OBELISCO = { latitude: -34.6037, longitude: -58.3816 };
const BELGRANO = { latitude: -34.5631, longitude: -58.4584 };
// Puntos propios de la prueba de radio, lejos de los de arriba (> 4 km), para
// que ninguna otra alerta del archivo alcance a las emergencias de prueba.
// 0,0027° de latitud ≈ 300 m; 0,0072° ≈ 800 m.
const CENTENARIO = { latitude: -34.6066, longitude: -58.4355 };
const MATADEROS = { latitude: -34.6596, longitude: -58.5026 };
const A_300_M = 0.0027;
const A_800_M = 0.0072;

const HORA = 60 * 60 * 1000;

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

function alNorte(punto, grados) {
  return { latitude: punto.latitude + grados, longitude: punto.longitude };
}

let pool;
let h;
let confirmada;
let finalizada;
let contextoZonaRepository;
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
      temperaturaMinC: null,
      temperaturaMaxC: null,
      actorSub: 'admin-1',
      ...overrides,
    },
  };
}

function finalizacion(alertaId) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  alertaIds.push(alertaId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.CriticidadClimaticaFinalizada', source: 'grupo7' },
    data: { alertaId, finalizadaEn: Date.now(), actorSub: 'admin-1' },
  };
}

async function contextosDe(alertaId) {
  const { rows } = await pool.query(
    `SELECT * FROM contexto_zona
     WHERE tipo = 'ALERTA_CLIMATICA' AND origen = 'espacios'
       AND split_part(referencia_externa, '#', 1) = $1
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

async function dispatchPriorityDe(location) {
  const id = await h.createPending({ emergencyType: 'MEDICA', location });
  const res = await h.call('get', `/api/emergencies/${id}`, 'dispatcher');
  return res.body.data;
}

async function esperarLocksEnEspera(cantidad) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
    );
    if (rows[0].n >= cantidad) return;
    if (Date.now() > deadline) throw new Error(`Timeout esperando ${cantidad} locks en espera`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  pool = getPool();
  h = await createLifecycleHarness(pool);
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  contextoZonaRepository = new ContextoZonaRepository(pool);

  const factory = new OutcomeFactory(pool, { dedupRepo: new EventosProcesadosRepository(pool) });
  factory.register(
    CREAR_EMERGENCIA_CLIMATICA,
    createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository, topic: CREATED_TOPIC })
  );
  factory.register(
    CANCELAR_EMERGENCIA_CLIMATICA,
    createCancelarEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository, topic: UPDATED_TOPIC })
  );
  factory.register(REGISTRAR_CONTEXTOS_CLIMATICOS, createRegistrarContextosClimaticosHandler({ contextoZonaRepository }));
  factory.register(DAR_DE_BAJA_CONTEXTOS_CLIMATICOS, createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository }));

  // Los tópicos son opt-in: acá se pasan explícitos.
  confirmada = new CriticidadClimaticaConfirmadaListener(fakeKafka(), { factory, topic: 'test.clima.confirmada' });
  finalizada = new CriticidadClimaticaFinalizadaListener(fakeKafka(), { factory, topic: 'test.clima.finalizada' });
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
  it('la confirmación ALTA deja un contexto de 500 m por punto y una emergencia climática', async () => {
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    const { alertaId } = evento.data;

    const contextos = await contextosDe(alertaId);
    expect(contextos.map((c) => c.referenciaExterna)).toEqual([`${alertaId}#0`, `${alertaId}#1`]);
    expect(contextos[0]).toMatchObject({
      latitud: OBELISCO.latitude,
      longitud: OBELISCO.longitude,
      radioMetros: 500,
      descripcion: 'Alerta climática ALTA: tormenta fuerte',
      causationId: evento.metadata.eventId,
      dadoDeBajaEn: null,
    });
    expect(contextos[1]).toMatchObject({ latitud: BELGRANO.latitude, radioMetros: 500 });
    expect(contextos[0].vigenteHasta.getTime()).toBe(evento.data.vigenciaHasta);

    const [emergencia] = await emergenciasDe(alertaId);
    expect(emergencia).toMatchObject({
      emergency_type: 'PREVENTIVA',
      severity: 'high',
      status: 'PENDING',
      source: 'EXTERNAL',
      user_id: null,
      requires_manual_validation: false,
      description: 'Alerta climática ALTA — tormenta fuerte (SAN NICOLAS, BELGRANO)',
    });

    const { rows } = await pool.query(
      "SELECT payload FROM outbox_events WHERE topic = $1 AND payload->'data'->>'emergenciaId' = $2",
      [CREATED_TOPIC, emergencia.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.data).toMatchObject({
      categoria: 'PREVENTIVA',
      causaTipo: 'EVENTO_CLIMATICO',
      causaId: alertaId,
      prioridad: 'ALTA',
      prioridadOriginal: 'ALTA',
      ciudadanoId: null,
    });

    // La emergencia de la alerta no queda elevada por sus propios contextos.
    const vinculos = await pool.query('SELECT 1 FROM emergencia_contexto_zona WHERE emergency_id = $1', [emergencia.id]);
    expect(vinculos.rowCount).toBe(0);
  });

  it('la confirmación CRITICA crea la emergencia critical y contextos de 1000 m', async () => {
    const evento = confirmacion({ nivelCriticidad: 'CRITICA' });
    await confirmada.onMessage(buildMessage(evento));

    const contextos = await contextosDe(evento.data.alertaId);
    expect(contextos.map((c) => c.radioMetros)).toEqual([1000, 1000]);
    const [emergencia] = await emergenciasDe(evento.data.alertaId);
    expect(emergencia.severity).toBe('critical');
  });

  it('una reentrega con otro eventId no duplica contextos ni emergencia', async () => {
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    const otra = confirmacion({ alertaId: evento.data.alertaId });
    await confirmada.onMessage(buildMessage(otra));

    expect(await contextosDe(evento.data.alertaId)).toHaveLength(2);
    expect(await emergenciasDe(evento.data.alertaId)).toHaveLength(1);
  });

  it('MEDIA y BAJA no dejan contextos ni emergencia', async () => {
    for (const nivelCriticidad of ['MEDIA', 'BAJA']) {
      const evento = confirmacion({ nivelCriticidad });
      await confirmada.onMessage(buildMessage(evento));
      expect(await contextosDe(evento.data.alertaId)).toHaveLength(0);
      expect(await emergenciasDe(evento.data.alertaId)).toHaveLength(0);
    }
  });

  it('una alerta que ya venció deja los contextos (sin efecto) pero no crea emergencia', async () => {
    const evento = confirmacion({ vigenciaDesde: Date.now() - 3 * HORA, vigenciaHasta: Date.now() - HORA });
    await confirmada.onMessage(buildMessage(evento));
    expect(await emergenciasDe(evento.data.alertaId)).toHaveLength(0);
  });

  it('el radio depende del nivel: CRITICA alcanza a 800 m, ALTA solo a 300 m', async () => {
    const critica = confirmacion({
      nivelCriticidad: 'CRITICA',
      ubicaciones: [{ latitud: CENTENARIO.latitude, longitud: CENTENARIO.longitude }],
    });
    const alta = confirmacion({
      nivelCriticidad: 'ALTA',
      ubicaciones: [{ latitud: MATADEROS.latitude, longitud: MATADEROS.longitude }],
    });
    await confirmada.onMessage(buildMessage(critica));
    await confirmada.onMessage(buildMessage(alta));

    const criticaA800 = await dispatchPriorityDe(alNorte(CENTENARIO, A_800_M));
    expect(criticaA800.dispatchPriority).toBe('critical');
    expect(criticaA800.priorityContext).toMatchObject({
      tipo: 'ALERTA_CLIMATICA',
      referenciaExterna: `${critica.data.alertaId}#0`,
      radioMetros: 1000,
      descripcion: 'Alerta climática CRITICA: tormenta fuerte',
    });

    const altaA300 = await dispatchPriorityDe(alNorte(MATADEROS, A_300_M));
    expect(altaA300.dispatchPriority).toBe('critical');
    expect(altaA300.priorityContext).toMatchObject({ referenciaExterna: `${alta.data.alertaId}#0`, radioMetros: 500 });

    const altaA800 = await dispatchPriorityDe(alNorte(MATADEROS, A_800_M));
    expect(altaA800.dispatchPriority).toBe('high');
    expect(altaA800.priorityContext).toBeNull();
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
    const { rows } = await pool.query(
      "SELECT payload FROM outbox_events WHERE topic = $1 AND payload->'data'->>'emergenciaId' = $2",
      [UPDATED_TOPIC, emergencia.id]
    );
    expect(rows.map((r) => r.payload.data.estadoNuevo)).toEqual(['CANCELADA']);
  });

  it('la finalización no toca una emergencia ya despachada', async () => {
    const evento = confirmacion({ nivelCriticidad: 'CRITICA' });
    await confirmada.onMessage(buildMessage(evento));
    const [creada] = await emergenciasDe(evento.data.alertaId);
    await pool.query("UPDATE emergencies SET status = 'DISPATCHED' WHERE id = $1", [creada.id]);

    await finalizada.onMessage(buildMessage(finalizacion(evento.data.alertaId)));
    const [emergencia] = await emergenciasDe(evento.data.alertaId);
    expect(emergencia.status).toBe('DISPATCHED');
    (await contextosDe(evento.data.alertaId)).forEach((c) => expect(c.dadoDeBajaEn).not.toBeNull());
  });

  it('si la finalización llega antes, la confirmación tardía no crea contextos ni emergencia', async () => {
    const alertaId = randomUUID();
    await finalizada.onMessage(buildMessage(finalizacion(alertaId)));
    await confirmada.onMessage(buildMessage(confirmacion({ alertaId, nivelCriticidad: 'CRITICA' })));

    const contextos = await contextosDe(alertaId);
    expect(contextos.map((c) => c.referenciaExterna)).toEqual([alertaId]);
    expect(contextos[0].dadoDeBajaEn).not.toBeNull();
    expect(await emergenciasDe(alertaId)).toHaveLength(0);
  });

  it('confirmación y finalización a la vez: no queda una PREVENTIVA viva ni contextos en curso', async () => {
    const evento = confirmacion({ nivelCriticidad: 'CRITICA' });
    const { alertaId } = evento.data;

    // Una transacción ajena toma el lock de la alerta: las dos entregas
    // arrancan y quedan esperando. Al soltarlo, una espera a la otra.
    const holder = await pool.connect();
    let pendientes;
    try {
      await holder.query('BEGIN');
      await contextoZonaRepository.bloquearGrupo(holder, grupoDeLaAlerta(alertaId));
      pendientes = Promise.all([
        confirmada.onMessage(buildMessage(evento)),
        finalizada.onMessage(buildMessage(finalizacion(alertaId))),
      ]);
      await esperarLocksEnEspera(2);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    await pendientes;

    const vivas = (await emergenciasDe(alertaId)).filter((e) => ['PENDING', 'VALIDATED'].includes(e.status));
    expect(vivas).toEqual([]);
    const contextos = await contextosDe(alertaId);
    expect(contextos.length).toBeGreaterThan(0);
    contextos.forEach((c) => expect(c.dadoDeBajaEn).not.toBeNull());
  });
});
