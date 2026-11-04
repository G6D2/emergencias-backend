// Test de integracion del consumer pipeline (issue #65).
// Kafka no corre en este test: se llama directamente a EventListener.onMessage()
// con un mensaje serializado. El DB es real (levantado por global-setup.js).
// Esto valida que el triangulo OutcomeFactory + dedup + INSERT funcione de punta
// a punta sin depender de que Kafka este disponible en el agente de CI.

const path = require('path');
const { getPool } = require('../../../db/pool');
const { EmergencyRepository } = require('../../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../../repositories/eventos-procesados.repository');
const { OutcomeFactory } = require('../../../listeners/outcome-factory');
const { EventoComunitarioPublicadoListener } = require('../../../listeners/cobertura-preventiva/evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('../../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { createLocationCrypto } = require('../../../security/location-crypto');

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

function buildMessage(eventObject) {
  return { value: Buffer.from(JSON.stringify(eventObject)) };
}

let pool;
let emergencyRepository;
let eventosProcesadosRepo;
let outcomeFactory;
let listener;

beforeAll(() => {
  pool = getPool();
  const locationCrypto = createLocationCrypto();
  emergencyRepository = new EmergencyRepository(pool, { locationCrypto });
  eventosProcesadosRepo = new EventosProcesadosRepository(pool);

  outcomeFactory = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
  outcomeFactory.register(
    PROGRAMAR_COBERTURA,
    createProgramarCoberturaHandler({
      locationCrypto,
      emergencyRepository,
      topic: 'com.citypass.emergencias',
    })
  );

  listener = new EventoComunitarioPublicadoListener(fakeKafka(), { factory: outcomeFactory });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM eventos_procesados');
  await pool.query("DELETE FROM emergencies WHERE source = 'EXTERNAL'");
  await pool.query("DELETE FROM outbox_events WHERE topic = 'com.citypass.emergencias'");
});

const BASE_EVENT = {
  metadata: {
    eventId: 'a1000000-0000-0000-0000-000000000001',
    eventType: 'EventoComunitarioPublicado',
    source: 'com.citypass.espacios',
    occurredAt: '2026-11-04T10:00:00.000Z',
  },
  data: {
    nombre: 'Feria del Libro 2026',
    capacidad: 1500,
    latitud: -34.615,
    longitud: -58.371,
  },
};

describe('consumer pipeline — EventoComunitarioPublicado → emergencia PENDING (integration)', () => {
  it('crea una emergencia EXTERNAL PENDING en la base', async () => {
    await listener.onMessage(buildMessage(BASE_EVENT));

    const { rows } = await pool.query(
      "SELECT * FROM emergencies WHERE source = 'EXTERNAL' ORDER BY created_at DESC LIMIT 1"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].emergency_type).toBe('DISTURBIO_EVENTO_MASIVO');
    expect(rows[0].severity).toBe('low');
    expect(rows[0].correlation_id).toBe(BASE_EVENT.metadata.eventId);
    expect(rows[0].requires_manual_validation).toBe(false);
  });

  it('encola EmergenciaCreada en el outbox dentro de la misma transaccion', async () => {
    await listener.onMessage(buildMessage(BASE_EVENT));

    const { rows } = await pool.query(
      "SELECT * FROM outbox_events WHERE topic = 'com.citypass.emergencias' ORDER BY created_at DESC LIMIT 1"
    );
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload;
    expect(payload.type).toBe('EmergenciaCreada');
    expect(payload.data.categoria).toBe('DISTURBIO_EVENTO_MASIVO');
  });

  it('marca el eventId en eventos_procesados', async () => {
    await listener.onMessage(buildMessage(BASE_EVENT));

    const row = await eventosProcesadosRepo.findById(BASE_EVENT.metadata.eventId);
    expect(row).not.toBeNull();
    expect(row.eventType).toBe('EventoComunitarioPublicado');
  });

  it('idempotencia: el segundo mensaje con el mismo eventId no crea otra emergencia', async () => {
    await listener.onMessage(buildMessage(BASE_EVENT));
    await listener.onMessage(buildMessage(BASE_EVENT));

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM emergencies WHERE source = 'EXTERNAL'"
    );
    expect(rows[0].n).toBe(1);
  });

  it('evento con capacidad < umbral no crea emergencia', async () => {
    const smallEvent = {
      ...BASE_EVENT,
      metadata: { ...BASE_EVENT.metadata, eventId: 'a2000000-0000-0000-0000-000000000001' },
      data: { ...BASE_EVENT.data, capacidad: 100 },
    };

    await listener.onMessage(buildMessage(smallEvent));

    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM emergencies WHERE source = 'EXTERNAL'");
    expect(rows[0].n).toBe(0);
  });

  it('JSON invalido se descarta sin lanzar', async () => {
    const badMessage = { value: Buffer.from('no-es-json') };
    await expect(listener.onMessage(badMessage)).resolves.toBeNull();
  });
});
