// Alerta climática de punta a punta (ADR "Elevar la prioridad con contextos
// de zona por radio o por barrio"): Espacios confirma una alerta por barrios
// y, mientras dura, las emergencias abiertas de esos barrios suben un nivel de
// prioridad de despacho, solo para los tipos que afecta el fenómeno y solo con
// gravedad ALTA o EXTREMA. Cuando la alerta se finaliza, la prioridad vuelve
// sola.
//
// Kafka no corre: se llama a EventListener.onMessage() con el mensaje
// serializado. Postgres y la app HTTP son reales.

const { randomUUID } = require('crypto');
const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
const { ContextoZonaRepository } = require('../../repositories/contexto-zona.repository');
const { OutcomeFactory } = require('../../listeners/outcome-factory');
const { AlertaClimaticaConfirmadaListener } = require('../../listeners/alerta-climatica/alerta-climatica-confirmada/alerta-climatica-confirmada.listener');
const { AlertaClimaticaFinalizadaListener } = require('../../listeners/alerta-climatica/alerta-climatica-finalizada/alerta-climatica-finalizada.listener');
const { EventoComunitarioPublicadoListener } = require('../../listeners/cobertura-preventiva/evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const {
  REGISTRAR_CONTEXTO_ZONA,
  DAR_DE_BAJA_CONTEXTO_ZONA,
  createRegistrarContextoZonaHandler,
  createDarDeBajaContextoZonaHandler,
} = require('../../listeners/cobertura-preventiva/handlers/contexto-zona.handler');
const { createLocationCrypto } = require('../../security/location-crypto');
const { createLifecycleHarness } = require('../helpers/emergency-lifecycle');

const CREATED_TOPIC = 'test.clima.emergencias.creada';

// PALERMO (cerca del Rosedal, dentro del radio de un evento ahí), RECOLETA y
// un punto fuera de CABA, sin barrio.
const ROSEDAL = { latitude: -34.5711, longitude: -58.4167 };
const PALERMO = { latitude: -34.5740, longitude: -58.4160 };
const RECOLETA = { latitude: -34.5869, longitude: -58.3930 };
const LA_PLATA = { latitude: -34.9214, longitude: -57.9545 };

const HORA = 60 * 60 * 1000;
const haceUnaHora = () => new Date(Date.now() - HORA).toISOString();
const enTresHoras = () => new Date(Date.now() + 3 * HORA).toISOString();

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

let pool;
let h;
let contextoZonaRepository;
let confirmada;
let finalizada;
let publicado;
const alertaIds = [];
const eventoIds = [];
const eventIds = [];

// Confirmación con el envelope plano del ejemplo de Espacios (eventId y
// occurredAt en la raíz).
function confirmacion(overrides = {}, { eventId = randomUUID(), occurredAt = new Date().toISOString() } = {}) {
  const alertaId = overrides.alertaId || randomUUID();
  alertaIds.push(alertaId);
  eventIds.push(eventId);
  return {
    eventId,
    eventType: 'espaciospublicos.alerta-climatica.confirmada',
    occurredAt,
    source: 'espacios-publicos',
    data: {
      alertaId,
      version: 1,
      fenomeno: 'TORMENTA_ELECTRICA',
      gravedad: 'ALTA',
      barrios: ['Palermo'],
      fechaInicio: haceUnaHora(),
      fechaFinEstimada: enTresHoras(),
      descripcion: 'Tormentas fuertes',
      ...overrides,
    },
  };
}

// Finalización con el envelope del gateway.
function finalizacion(alertaId) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'espaciospublicos.alerta-climatica.finalizada', occurredAt: new Date().toISOString() },
    data: { alertaId },
  };
}

function publicacionEvento() {
  const eventoId = `ev-clima-${randomUUID().slice(0, 8)}`;
  const eventId = randomUUID();
  eventoIds.push(eventoId);
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.EventoComunitarioPublicado', source: 'grupo7' },
    data: {
      eventoId,
      titulo: 'Feria en el Rosedal',
      capacidad: 50,
      latitud: ROSEDAL.latitude,
      longitud: ROSEDAL.longitude,
      estado: 'ACTIVE',
      inicio: haceUnaHora(),
      fin: enTresHoras(),
    },
  };
}

async function detalle(id) {
  const res = await h.call('get', `/api/emergencies/${id}`, 'dispatcher');
  expect(res.status).toBe(200);
  return res.body.data;
}

async function contextoDe(alertaId) {
  return contextoZonaRepository.findByReferencia(null, {
    tipo: 'ALERTA_CLIMATICA',
    origen: 'espacios',
    referenciaExterna: alertaId,
  });
}

async function limpiarContextos() {
  await pool.query(
    'DELETE FROM contexto_zona WHERE referencia_externa = ANY($1::text[])',
    [[...alertaIds, ...eventoIds]]
  );
}

beforeAll(async () => {
  pool = getPool();
  h = await createLifecycleHarness(pool);
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  contextoZonaRepository = new ContextoZonaRepository(pool);

  const factory = new OutcomeFactory(pool, { dedupRepo: new EventosProcesadosRepository(pool) });
  factory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  factory.register(REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler({ contextoZonaRepository }));
  factory.register(DAR_DE_BAJA_CONTEXTO_ZONA, createDarDeBajaContextoZonaHandler({ contextoZonaRepository }));

  confirmada = new AlertaClimaticaConfirmadaListener(fakeKafka(), { factory });
  finalizada = new AlertaClimaticaFinalizadaListener(fakeKafka(), { factory });
  publicado = new EventoComunitarioPublicadoListener(fakeKafka(), { factory });
});

afterEach(async () => {
  await limpiarContextos();
});

afterAll(async () => {
  await limpiarContextos();
  await pool.query('DELETE FROM eventos_procesados WHERE event_id = ANY($1::uuid[])', [eventIds]);
  await pool.query('DELETE FROM outbox_events WHERE topic = $1', [CREATED_TOPIC]);
  await h.cleanup();
  await pool.end();
});

describe('alerta climática por barrio (integration)', () => {
  it('una alerta ALTA sube las emergencias abiertas del barrio de los tipos afectados, aunque sean anteriores', async () => {
    const infraPalermo = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const disturbioPalermo = await h.createPending({ emergencyType: 'DISTURBIO_EVENTO_MASIVO', location: PALERMO });
    const infraRecoleta = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: RECOLETA });
    const infraSinBarrio = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: LA_PLATA });

    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));

    const contexto = await contextoDe(evento.data.alertaId);
    expect(contexto).toMatchObject({
      barrios: ['PALERMO'],
      tiposEmergencia: ['INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO'],
      fenomeno: 'TORMENTA_ELECTRICA',
      gravedad: 'ALTA',
      versionOrigen: 1,
      latitud: null,
      radioMetros: null,
      causationId: evento.eventId,
    });

    const elevada = await detalle(infraPalermo);
    expect(elevada.barrio).toBe('PALERMO');
    expect(elevada.effectivePriority).toBe('medium');
    expect(elevada.dispatchPriority).toBe('high');
    expect(elevada.priorityContext).toMatchObject({
      tipo: 'ALERTA_CLIMATICA',
      barrios: ['PALERMO'],
      fenomeno: 'TORMENTA_ELECTRICA',
      gravedad: 'ALTA',
      referenciaExterna: evento.data.alertaId,
    });
    // La prioridad guardada no se toca, y la alerta no deja vínculos.
    expect((await h.emergencyRow(infraPalermo)).severity).toBe('medium');
    const vinculos = await pool.query('SELECT 1 FROM emergencia_contexto_zona WHERE emergency_id = $1', [infraPalermo]);
    expect(vinculos.rows).toHaveLength(0);

    // El clima no agrava un disturbio.
    const disturbio = await detalle(disturbioPalermo);
    expect(disturbio.dispatchPriority).toBe('medium');
    expect(disturbio.priorityContext).toBeNull();

    // Otro barrio, o sin barrio: no sube.
    expect((await detalle(infraRecoleta)).dispatchPriority).toBe('medium');
    const sinBarrio = await detalle(infraSinBarrio);
    expect(sinBarrio.barrio).toBeNull();
    expect(sinBarrio.dispatchPriority).toBe('medium');
  });

  it('también sube las emergencias que se crean durante la alerta', async () => {
    await confirmada.onMessage(buildMessage(confirmacion()));
    const nueva = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    expect((await detalle(nueva)).dispatchPriority).toBe('high');
  });

  it('una alerta LEVE existe y la devuelve findActivos, pero no sube nada', async () => {
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = confirmacion({ gravedad: 'LEVE' });
    await confirmada.onMessage(buildMessage(evento));

    expect((await contextoDe(evento.data.alertaId)).tiposEmergencia).toEqual([]);
    const activos = await contextoZonaRepository.findActivos(null, { tipo: 'ALERTA_CLIMATICA' });
    expect(activos.map((c) => c.referenciaExterna)).toContain(evento.data.alertaId);

    const emergencia = await detalle(id);
    expect(emergencia.dispatchPriority).toBe('medium');
    expect(emergencia.priorityContext).toBeNull();
  });

  it('findActivos incluye una alerta que todavía no empezó, que tampoco eleva', async () => {
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = confirmacion({
      fechaInicio: new Date(Date.now() + HORA).toISOString(),
      fechaFinEstimada: new Date(Date.now() + 4 * HORA).toISOString(),
    });
    await confirmada.onMessage(buildMessage(evento));

    const activos = await contextoZonaRepository.findActivos(null, { tipo: 'ALERTA_CLIMATICA' });
    expect(activos.map((c) => c.referenciaExterna)).toContain(evento.data.alertaId);
    expect((await detalle(id)).dispatchPriority).toBe('medium');
  });

  it('una version 2 con gravedad MEDIA deja de elevar; una version 1 que llega después no vuelve a elevar', async () => {
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const v1 = confirmacion({}, { occurredAt: new Date(Date.now() - 60_000).toISOString() });
    const alertaId = v1.data.alertaId;
    await confirmada.onMessage(buildMessage(v1));
    expect((await detalle(id)).dispatchPriority).toBe('high');

    await confirmada.onMessage(buildMessage(confirmacion({ alertaId, version: 2, gravedad: 'MEDIA' })));
    expect((await detalle(id)).dispatchPriority).toBe('medium');

    // La version 1 se reentrega con otro eventId y hasta con un occurredAt más
    // nuevo: la versión sola alcanza para descartarla.
    await confirmada.onMessage(buildMessage(confirmacion(
      { alertaId, version: 1, gravedad: 'EXTREMA' },
      { occurredAt: new Date(Date.now() + 60_000).toISOString() }
    )));
    const contexto = await contextoDe(alertaId);
    expect(contexto.versionOrigen).toBe(2);
    expect(contexto.gravedad).toBe('MEDIA');
    expect((await detalle(id)).dispatchPriority).toBe('medium');
  });

  it('una version nueva puede sumar barrios a la misma alerta', async () => {
    const recoleta = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: RECOLETA });
    const v1 = confirmacion({}, { occurredAt: new Date(Date.now() - 60_000).toISOString() });
    await confirmada.onMessage(buildMessage(v1));
    expect((await detalle(recoleta)).dispatchPriority).toBe('medium');

    await confirmada.onMessage(buildMessage(confirmacion({
      alertaId: v1.data.alertaId, version: 2, barrios: ['Palermo', 'Recoleta'],
    })));
    expect((await detalle(recoleta)).dispatchPriority).toBe('high');
  });

  it('la finalización devuelve la prioridad original en la próxima lectura', async () => {
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    expect((await detalle(id)).dispatchPriority).toBe('high');

    await finalizada.onMessage(buildMessage(finalizacion(evento.data.alertaId)));

    expect((await contextoDe(evento.data.alertaId)).dadoDeBajaEn).not.toBeNull();
    const despues = await detalle(id);
    expect(despues.dispatchPriority).toBe('medium');
    expect(despues.priorityContext).toBeNull();
    const activos = await contextoZonaRepository.findActivos(null, { tipo: 'ALERTA_CLIMATICA' });
    expect(activos.map((c) => c.referenciaExterna)).not.toContain(evento.data.alertaId);
  });

  it('si la finalización llega antes que la confirmación, la confirmación tardía se ignora', async () => {
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = confirmacion();
    await finalizada.onMessage(buildMessage(finalizacion(evento.data.alertaId)));
    await confirmada.onMessage(buildMessage(evento));

    const contexto = await contextoDe(evento.data.alertaId);
    expect(contexto.dadoDeBajaEn).not.toBeNull();
    expect(contexto.barrios).toBeNull();
    expect((await detalle(id)).dispatchPriority).toBe('medium');
  });

  it('al vencer el tope de seguridad la prioridad vuelve sola', async () => {
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    expect((await detalle(id)).dispatchPriority).toBe('high');

    await pool.query(
      "UPDATE contexto_zona SET vigente_hasta = now() - interval '1 second' WHERE referencia_externa = $1",
      [evento.data.alertaId]
    );
    expect((await detalle(id)).dispatchPriority).toBe('medium');
  });

  it('un evento por radio y una alerta por barrio sobre la misma emergencia suben un nivel, no dos', async () => {
    await publicado.onMessage(buildMessage(publicacionEvento()));
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    expect((await detalle(id)).dispatchPriority).toBe('high');

    await confirmada.onMessage(buildMessage(confirmacion()));

    const emergencia = await detalle(id);
    expect(emergencia.effectivePriority).toBe('medium');
    expect(emergencia.dispatchPriority).toBe('high');
  });

  it('el orden por prioridad entre páginas cuenta la suba por barrio', async () => {
    const { rows: [{ desde }] } = await pool.query('SELECT now() AS desde');
    // Recoleta se crea primero: sin la alerta iría primera (misma prioridad,
    // la más vieja antes).
    const recoleta = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: RECOLETA });
    const palermo = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    await confirmada.onMessage(buildMessage(confirmacion()));

    const pagina = (page) => h.call(
      'get',
      `/api/emergencies?emergencyType=INFRAESTRUCTURA&from=${encodeURIComponent(desde.toISOString())}`
        + `&sortBy=priority&order=desc&limit=1&page=${page}`,
      'dispatcher'
    );
    const [primera, segunda] = await Promise.all([pagina(1), pagina(2)]);
    expect(primera.status).toBe(200);
    expect(primera.body.data.map((e) => e.id)).toEqual([palermo]);
    expect(primera.body.data[0].dispatchPriority).toBe('high');
    expect(segunda.body.data.map((e) => e.id)).toEqual([recoleta]);
    expect(segunda.body.data[0].dispatchPriority).toBe('medium');
  });

  it('el mismo eventId dos veces tiene un solo efecto', async () => {
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = confirmacion();
    await confirmada.onMessage(buildMessage(evento));
    // Mismo eventId con otro contenido: se descarta por duplicado.
    await confirmada.onMessage(buildMessage({ ...evento, data: { ...evento.data, version: 5, gravedad: 'LEVE' } }));

    const contexto = await contextoDe(evento.data.alertaId);
    expect(contexto.gravedad).toBe('ALTA');
    expect(contexto.versionOrigen).toBe(1);
    const procesados = await pool.query('SELECT 1 FROM eventos_procesados WHERE event_id = $1', [evento.eventId]);
    expect(procesados.rows).toHaveLength(1);
    expect((await detalle(id)).dispatchPriority).toBe('high');
  });

  it('una alerta sin barrios del catálogo no crea contexto', async () => {
    const evento = confirmacion({ barrios: ['Narnia'] });
    await confirmada.onMessage(buildMessage(evento));
    expect(await contextoDe(evento.data.alertaId)).toBeNull();
  });
});

// Contrato real de Espacios (guía "CityPass Eventos climáticos", 13/11/2026):
// CriticidadClimaticaConfirmada / CriticidadClimaticaFinalizada con el
// envelope del gateway, nivelCriticidad y fechas en Unix ms.
function criticidadConfirmada(overrides = {}) {
  const alertaId = overrides.alertaId || randomUUID();
  const eventId = randomUUID();
  alertaIds.push(alertaId);
  eventIds.push(eventId);
  return {
    metadata: {
      eventId,
      eventType: 'com.citypass.espacios.CriticidadClimaticaConfirmada',
      source: 'grupo7',
      receivedAt: new Date().toISOString(),
    },
    data: {
      alertaId,
      nivelCriticidad: 'ALTA',
      fenomeno: 'OLA_DE_CALOR',
      ubicaciones: [{ latitud: PALERMO.latitude, longitud: PALERMO.longitude }],
      barrios: ['PALERMO'],
      vigenciaDesde: Date.now() - HORA,
      vigenciaHasta: Date.now() + 3 * HORA,
      temperaturaMinC: 28.0,
      temperaturaMaxC: 38.0,
      actorSub: 'admin-ejemplo',
      ...overrides,
    },
  };
}

function criticidadFinalizada(alertaId) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  return {
    metadata: {
      eventId,
      eventType: 'com.citypass.espacios.CriticidadClimaticaFinalizada',
      source: 'grupo7',
      receivedAt: new Date().toISOString(),
    },
    data: { alertaId, finalizadaEn: Date.now(), actorSub: 'admin-ejemplo' },
  };
}

describe('alerta climática con el contrato real de Espacios (integration)', () => {
  it('una alerta real ALTA sube la INFRAESTRUCTURA abierta del barrio y no el disturbio', async () => {
    const infra = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const disturbio = await h.createPending({ emergencyType: 'DISTURBIO_EVENTO_MASIVO', location: PALERMO });
    const evento = criticidadConfirmada();

    await confirmada.onMessage(buildMessage(evento));

    const contexto = await contextoDe(evento.data.alertaId);
    expect(contexto).toMatchObject({
      barrios: ['PALERMO'],
      fenomeno: 'OLA_DE_CALOR',
      gravedad: 'ALTA',
      tiposEmergencia: ['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA'],
      causationId: evento.metadata.eventId,
    });
    expect(contexto.vigenteDesde.getTime()).toBe(evento.data.vigenciaDesde);
    expect(contexto.vigenteHasta.getTime()).toBe(evento.data.vigenciaHasta + 3 * HORA);

    const elevada = await detalle(infra);
    expect(elevada.dispatchPriority).toBe('high');
    expect(elevada.priorityContext).toMatchObject({ tipo: 'ALERTA_CLIMATICA', fenomeno: 'OLA_DE_CALOR', gravedad: 'ALTA' });
    expect((await detalle(disturbio)).dispatchPriority).toBe('medium');
  });

  it('con barrios vacío deriva el barrio de las ubicaciones y eleva igual', async () => {
    const infra = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = criticidadConfirmada({ barrios: [] });

    await confirmada.onMessage(buildMessage(evento));

    expect((await contextoDe(evento.data.alertaId)).barrios).toEqual(['PALERMO']);
    expect((await detalle(infra)).dispatchPriority).toBe('high');
  });

  it('CRITICA sube; BAJA crea el contexto y no sube', async () => {
    const infra = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });

    const baja = criticidadConfirmada({ nivelCriticidad: 'BAJA' });
    await confirmada.onMessage(buildMessage(baja));
    expect((await contextoDe(baja.data.alertaId))).toMatchObject({ gravedad: 'LEVE', tiposEmergencia: [] });
    expect((await detalle(infra)).dispatchPriority).toBe('medium');

    const critica = criticidadConfirmada({ nivelCriticidad: 'CRITICA' });
    await confirmada.onMessage(buildMessage(critica));
    expect((await contextoDe(critica.data.alertaId)).gravedad).toBe('EXTREMA');
    expect((await detalle(infra)).dispatchPriority).toBe('high');
  });

  it('CriticidadClimaticaFinalizada con el mismo alertaId devuelve la prioridad original', async () => {
    const infra = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: PALERMO });
    const evento = criticidadConfirmada();
    await confirmada.onMessage(buildMessage(evento));
    expect((await detalle(infra)).dispatchPriority).toBe('high');

    await finalizada.onMessage(buildMessage(criticidadFinalizada(evento.data.alertaId)));

    expect((await contextoDe(evento.data.alertaId)).dadoDeBajaEn).not.toBeNull();
    const despues = await detalle(infra);
    expect(despues.dispatchPriority).toBe('medium');
    expect(despues.priorityContext).toBeNull();
  });
});
