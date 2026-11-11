// Contexto de zona de punta a punta (ADR "Elevar temporalmente la prioridad
// con contextos de zona"): un EventoComunitarioPublicado de Espacios deja un
// contexto en su barrio y, mientras está vigente, las emergencias de ese
// barrio suben un nivel de prioridad de despacho. Un EventoCancelado lo da de
// baja y la prioridad vuelve sola.
//
// Kafka no corre: se llama a EventListener.onMessage() con el mensaje
// serializado. Postgres y la app HTTP son reales.

const { randomUUID } = require('crypto');
const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
const { ContextoZonaRepository } = require('../../repositories/contexto-zona.repository');
const { OutcomeFactory } = require('../../listeners/outcome-factory');
const { EventoComunitarioPublicadoListener } = require('../../listeners/cobertura-preventiva/evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { EventoCanceladoListener } = require('../../listeners/cobertura-preventiva/evento-cancelado/evento-cancelado.listener');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { CANCELAR_COBERTURA, createCancelarCoberturaHandler } = require('../../listeners/cobertura-preventiva/handlers/cancelar-cobertura.handler');
const {
  REGISTRAR_CONTEXTO_ZONA,
  DAR_DE_BAJA_CONTEXTO_ZONA,
  createRegistrarContextoZonaHandler,
  createDarDeBajaContextoZonaHandler,
} = require('../../listeners/cobertura-preventiva/handlers/contexto-zona.handler');
const { createLocationCrypto } = require('../../security/location-crypto');
const { createLifecycleHarness } = require('../helpers/emergency-lifecycle');

const CREATED_TOPIC = 'test.contexto.emergencias.creada';
const UPDATED_TOPIC = 'test.contexto.emergencias.actualizada';

// Rosedal (PALERMO) y Obelisco (SAN NICOLAS).
const EN_PALERMO = { latitude: -34.5711, longitude: -58.4167 };
const EN_SAN_NICOLAS = { latitude: -34.6037, longitude: -58.3816 };

const HORA = 60 * 60 * 1000;
const haceUnaHora = () => new Date(Date.now() - HORA).toISOString();
const enDosHoras = () => new Date(Date.now() + 2 * HORA).toISOString();

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

let pool;
let h;
let emergencyRepository;
let contextoZonaRepository;
let publicado;
let cancelado;
const eventoIds = [];
const eventIds = [];

// Evento comunitario en el Rosedal, chico (no llega al umbral de cobertura
// preventiva): el contexto de zona no depende de la capacidad.
function publicacion(overrides = {}) {
  const eventoId = overrides.eventoId || `ev-contexto-${randomUUID().slice(0, 8)}`;
  const eventId = randomUUID();
  eventoIds.push(eventoId);
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.EventoComunitarioPublicado', source: 'grupo7' },
    data: {
      eventoId,
      titulo: 'Recital en el Rosedal',
      capacidad: 50,
      latitud: EN_PALERMO.latitude,
      longitud: EN_PALERMO.longitude,
      estado: 'ACTIVE',
      inicio: haceUnaHora(),
      fin: enDosHoras(),
      correlationId: `evento-${eventoId}`,
      ...overrides,
    },
  };
}

function cancelacion(eventoId) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.EventoCancelado', source: 'grupo7' },
    data: { eventoId, motivo: 'lluvia', canceladoEn: new Date().toISOString() },
  };
}

async function detalle(id) {
  const res = await h.call('get', `/api/emergencies/${id}`, 'dispatcher');
  expect(res.status).toBe(200);
  return res.body.data;
}

async function contextoDe(eventoId) {
  return contextoZonaRepository.findByReferencia(null, {
    tipo: 'EVENTO_ESPACIO_PUBLICO',
    origen: 'espacios',
    referenciaExterna: eventoId,
  });
}

async function limpiarContextos() {
  await pool.query('DELETE FROM contexto_zona WHERE referencia_externa = ANY($1::text[])', [eventoIds]);
}

beforeAll(async () => {
  pool = getPool();
  h = await createLifecycleHarness(pool);
  emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  contextoZonaRepository = new ContextoZonaRepository(pool);

  const factory = new OutcomeFactory(pool, { dedupRepo: new EventosProcesadosRepository(pool) });
  factory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  factory.register(CANCELAR_COBERTURA, createCancelarCoberturaHandler({ emergencyRepository, topic: UPDATED_TOPIC }));
  factory.register(REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler({ contextoZonaRepository }));
  factory.register(DAR_DE_BAJA_CONTEXTO_ZONA, createDarDeBajaContextoZonaHandler({ contextoZonaRepository }));

  publicado = new EventoComunitarioPublicadoListener(fakeKafka(), { factory });
  cancelado = new EventoCanceladoListener(fakeKafka(), { factory });
});

afterEach(async () => {
  await limpiarContextos();
});

afterAll(async () => {
  await limpiarContextos();
  await pool.query('DELETE FROM eventos_procesados WHERE event_id = ANY($1::uuid[])', [eventIds]);
  await pool.query(
    "DELETE FROM emergencies WHERE causa_tipo = 'EVENTO_PUBLICO' AND causa_id = ANY($1::text[])",
    [eventoIds]
  );
  await pool.query('DELETE FROM outbox_events WHERE topic IN ($1, $2)', [CREATED_TOPIC, UPDATED_TOPIC]);
  await h.cleanup();
  await pool.end();
});

describe('contexto de zona por evento comunitario (integration)', () => {
  it('la publicación crea el contexto en el barrio del evento con su ventana', async () => {
    const evento = publicacion();
    await publicado.onMessage(buildMessage(evento));

    const contexto = await contextoDe(evento.data.eventoId);
    expect(contexto).toMatchObject({
      tipo: 'EVENTO_ESPACIO_PUBLICO',
      barrio: 'PALERMO',
      origen: 'espacios',
      descripcion: 'Recital en el Rosedal',
      causationId: evento.metadata.eventId,
      dadoDeBajaEn: null,
    });
    expect(contexto.vigenteDesde.toISOString()).toBe(evento.data.inicio);
    expect(contexto.vigenteHasta.toISOString()).toBe(evento.data.fin);
  });

  it('durante el evento, una emergencia nueva del barrio sube un nivel; la de otro barrio no', async () => {
    const evento = publicacion();
    await publicado.onMessage(buildMessage(evento));

    const enElBarrio = await h.createPending({ emergencyType: 'MEDICA', location: EN_PALERMO });
    const enOtroBarrio = await h.createPending({ emergencyType: 'MEDICA', location: EN_SAN_NICOLAS });

    const elevada = await detalle(enElBarrio);
    expect(elevada.severity).toBe('high');
    expect(elevada.effectivePriority).toBe('high');
    expect(elevada.dispatchPriority).toBe('critical');
    expect(elevada.priorityContext).toMatchObject({
      tipo: 'EVENTO_ESPACIO_PUBLICO',
      barrio: 'PALERMO',
      referenciaExterna: evento.data.eventoId,
      descripcion: 'Recital en el Rosedal',
    });

    const normal = await detalle(enOtroBarrio);
    expect(normal.dispatchPriority).toBe('high');
    expect(normal.priorityContext).toBeNull();

    // La prioridad guardada no se toca.
    expect((await h.emergencyRow(enElBarrio)).severity).toBe('high');
  });

  it('la cancelación da de baja el contexto y la prioridad vuelve a la normal', async () => {
    const evento = publicacion();
    await publicado.onMessage(buildMessage(evento));
    const id = await h.createPending({ emergencyType: 'INFRAESTRUCTURA', location: EN_PALERMO });
    expect((await detalle(id)).dispatchPriority).toBe('high');

    await cancelado.onMessage(buildMessage(cancelacion(evento.data.eventoId)));

    expect((await contextoDe(evento.data.eventoId)).dadoDeBajaEn).not.toBeNull();
    const despues = await detalle(id);
    expect(despues.dispatchPriority).toBe('medium');
    expect(despues.priorityContext).toBeNull();
  });

  it('una republicación después de la cancelación no revive el contexto', async () => {
    const evento = publicacion();
    await publicado.onMessage(buildMessage(evento));
    await cancelado.onMessage(buildMessage(cancelacion(evento.data.eventoId)));
    await publicado.onMessage(buildMessage(publicacion({ eventoId: evento.data.eventoId })));

    expect((await contextoDe(evento.data.eventoId)).dadoDeBajaEn).not.toBeNull();
    const id = await h.createPending({ emergencyType: 'MEDICA', location: EN_PALERMO });
    expect((await detalle(id)).dispatchPriority).toBe('high');
  });

  it('una cancelación que llega antes que la publicación deja el contexto dado de baja', async () => {
    const evento = publicacion();
    await cancelado.onMessage(buildMessage(cancelacion(evento.data.eventoId)));
    await publicado.onMessage(buildMessage(evento));

    const contexto = await contextoDe(evento.data.eventoId);
    expect(contexto.dadoDeBajaEn).not.toBeNull();
    expect(contexto.barrio).toBeNull();
    const id = await h.createPending({ emergencyType: 'MEDICA', location: EN_PALERMO });
    expect((await detalle(id)).priorityContext).toBeNull();
  });

  it('un evento publicado ya cancelado da de baja el contexto', async () => {
    const evento = publicacion();
    await publicado.onMessage(buildMessage(evento));
    await publicado.onMessage(buildMessage(publicacion({ eventoId: evento.data.eventoId, estado: 'CANCELLED' })));

    expect((await contextoDe(evento.data.eventoId)).dadoDeBajaEn).not.toBeNull();
  });

  it('antes de que empiece y después de que termina el evento no hay suba', async () => {
    const futuro = publicacion({
      inicio: new Date(Date.now() + HORA).toISOString(),
      fin: new Date(Date.now() + 3 * HORA).toISOString(),
    });
    const pasado = publicacion({
      inicio: new Date(Date.now() - 3 * HORA).toISOString(),
      fin: haceUnaHora(),
    });
    await publicado.onMessage(buildMessage(futuro));
    await publicado.onMessage(buildMessage(pasado));

    const id = await h.createPending({ emergencyType: 'MEDICA', location: EN_PALERMO });
    const emergencia = await detalle(id);
    expect(emergencia.dispatchPriority).toBe('high');
    expect(emergencia.priorityContext).toBeNull();
  });

  it('una republicación actualiza la ventana del mismo contexto', async () => {
    const evento = publicacion();
    await publicado.onMessage(buildMessage(evento));
    const nuevoFin = new Date(Date.now() + 5 * HORA).toISOString();
    await publicado.onMessage(buildMessage(publicacion({ eventoId: evento.data.eventoId, fin: nuevoFin })));

    const { rows } = await pool.query(
      'SELECT vigente_hasta FROM contexto_zona WHERE referencia_externa = $1',
      [evento.data.eventoId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].vigente_hasta.toISOString()).toBe(nuevoFin);
  });

  it('dos eventos en el mismo barrio suben un solo nivel, y critical sigue critical', async () => {
    await publicado.onMessage(buildMessage(publicacion()));
    await publicado.onMessage(buildMessage(publicacion({ titulo: 'Feria en Plaza Italia' })));

    const otro = await h.createPending({ emergencyType: 'OTRO', location: EN_PALERMO });
    const panico = await h.createPending({ location: EN_PALERMO });

    expect((await detalle(otro)).dispatchPriority).toBe('medium');
    expect((await detalle(panico)).dispatchPriority).toBe('critical');
  });

  it('no sube la cobertura PREVENTIVA del propio evento ni una emergencia ya terminada', async () => {
    const evento = publicacion({ capacidad: 5000 });
    await publicado.onMessage(buildMessage(evento));

    const [cobertura] = await emergencyRepository.findByCausa(pool, {
      causaTipo: 'EVENTO_PUBLICO',
      causaId: evento.data.eventoId,
      emergencyType: 'PREVENTIVA',
    });
    const preventiva = await detalle(cobertura.id);
    expect(preventiva.barrio).toBe('PALERMO');
    expect(preventiva.dispatchPriority).toBe('low');

    const cancelada = await h.createPending({ emergencyType: 'MEDICA', location: EN_PALERMO });
    await h.patch(cancelada, 'cancel', 'citizen', { reason: 'falsa alarma' }).expect(200);
    expect((await detalle(cancelada)).dispatchPriority).toBe('high');
  });

  it('sortBy=priority ordena por prioridad de despacho, también entre páginas', async () => {
    await publicado.onMessage(buildMessage(publicacion()));
    // Misma severity (high): la del barrio del evento es posterior, pero va primero.
    const fuera = await h.createPending({ emergencyType: 'INCENDIO', location: EN_SAN_NICOLAS });
    const dentro = await h.createPending({ emergencyType: 'INCENDIO', location: EN_PALERMO });

    const pagina = (page) => emergencyRepository.findPage({
      userId: h.identities.citizen.sub,
      statuses: ['PENDING'],
      emergencyType: 'INCENDIO',
      page,
      limit: 1,
      sortBy: 'priority',
      order: 'desc',
    });
    const primera = await pagina(1);
    const segunda = await pagina(2);

    expect(primera.emergencies.map((e) => e.id)).toEqual([dentro]);
    expect(primera.emergencies[0].dispatchPriority).toBe('critical');
    expect(segunda.emergencies.map((e) => e.id)).toEqual([fuera]);
    expect(segunda.emergencies[0].dispatchPriority).toBe('high');
  });

  it('el listado del dispatcher trae la prioridad de despacho; el ciudadano no la ve', async () => {
    await publicado.onMessage(buildMessage(publicacion()));
    const id = await h.createPending({ emergencyType: 'MEDICA', location: EN_PALERMO });

    const comoCiudadano = await h.call('get', '/api/emergencies?limit=100', 'citizen');
    const propia = comoCiudadano.body.data.find((e) => e.id === id);
    expect(propia).toBeDefined();
    expect(propia).not.toHaveProperty('dispatchPriority');
    expect(propia).not.toHaveProperty('priorityContext');

    const detalleCiudadano = await h.call('get', `/api/emergencies/${id}`, 'citizen');
    expect(detalleCiudadano.body.data).not.toHaveProperty('dispatchPriority');
    expect(detalleCiudadano.body.data).not.toHaveProperty('priorityContext');
  });

  it('un evento fuera de CABA o sin ubicación no crea contexto', async () => {
    const lejos = publicacion({ latitud: -31.4201, longitud: -64.1888 });
    const sinUbicacion = publicacion({ latitud: null, longitud: null });
    await publicado.onMessage(buildMessage(lejos));
    await publicado.onMessage(buildMessage(sinUbicacion));

    expect(await contextoDe(lejos.data.eventoId)).toBeNull();
    expect(await contextoDe(sinUbicacion.data.eventoId)).toBeNull();
  });
});
