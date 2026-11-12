// Consumer con Avro real en formato Confluent (issue #65, ADR #25).
//
// consumer.integration.test.js manda JSON, que el decoder lee por el atajo
// "no empieza con 0x00". Esta suite ejercita el camino de producción: el
// mensaje es [0x00][schemaId: 4 bytes BE][Avro binario] codificado con avsc,
// el decoder real (registryFromEnv → @kafkajs/confluent-schema-registry)
// resuelve el schema contra un registry HTTP local que sirve
// /schemas/ids/{id}, y el evento sigue por onMessage → reglas →
// OutcomeFactory → Postgres real. Kafka no corre.

const http = require('http');
const { randomUUID } = require('crypto');
const avro = require('avsc');
const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
const { OutcomeFactory } = require('../../listeners/outcome-factory');
const { createEventDecoder, registryFromEnv, MAGIC_BYTE } = require('../../listeners/event-decoder');
const { EventoComunitarioPublicadoListener } = require('../../listeners/cobertura-preventiva/evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler } = require('../../listeners/cobertura-preventiva/handlers/contexto-zona.handler');
const { ContextoZonaRepository } = require('../../repositories/contexto-zona.repository');

const CREATED_TOPIC = 'test.avro.emergencias.creada';

// Ids de schema que sirve el registry local, uno por comportamiento (el
// cliente cachea por id, así que cada caso usa el suyo).
const SCHEMA_ID_OK = 4711;
const SCHEMA_ID_NOT_FOUND = 4040;
const SCHEMA_ID_UNAVAILABLE = 5030;

const EVENTO_COMUNITARIO_PUBLICADO_SCHEMA = {
  type: 'record',
  name: 'EventoComunitarioPublicado',
  namespace: 'com.citypass.espacios',
  fields: [
    {
      name: 'metadata',
      type: {
        type: 'record',
        name: 'Metadata',
        fields: [
          { name: 'eventId', type: 'string' },
          { name: 'eventType', type: 'string' },
          { name: 'source', type: 'string' },
        ],
      },
    },
    {
      name: 'data',
      type: {
        type: 'record',
        name: 'EventoComunitario',
        fields: [
          { name: 'eventoId', type: 'string' },
          { name: 'titulo', type: 'string' },
          { name: 'capacidad', type: 'int' },
          { name: 'latitud', type: ['null', 'double'], default: null },
          { name: 'longitud', type: ['null', 'double'], default: null },
          { name: 'direccion', type: ['null', 'string'], default: null },
          { name: 'estado', type: 'string' },
          { name: 'correlationId', type: 'string' },
        ],
      },
    },
  ],
};

const avroType = avro.Type.forSchema(EVENTO_COMUNITARIO_PUBLICADO_SCHEMA);

function confluentMessage(schemaId, event) {
  const header = Buffer.alloc(5);
  header.writeUInt8(MAGIC_BYTE, 0);
  header.writeInt32BE(schemaId, 1);
  return { value: Buffer.concat([header, avroType.toBuffer(event)]) };
}

function fakeKafka() {
  return { consumer: jest.fn() };
}

const tag = randomUUID().slice(0, 8);
const usedEventIds = [];
const usedEventoIds = [];

function publicado({ latitud = -34.5889, longitud = -58.3974 } = {}) {
  const eventId = randomUUID();
  const eventoId = `ev-avro-${tag}-${usedEventoIds.length + 1}`;
  usedEventIds.push(eventId);
  usedEventoIds.push(eventoId);
  return {
    metadata: {
      eventId,
      eventType: 'com.citypass.espacios.EventoComunitarioPublicado',
      source: 'grupo7',
    },
    data: {
      eventoId,
      titulo: 'Recital en el Rosedal',
      capacidad: 4000,
      latitud,
      longitud,
      direccion: 'Av. Infanta Isabel 410',
      estado: 'ACTIVE',
      correlationId: `evento-${eventoId}`,
    },
  };
}

let server;
let registryUrl;
const registryRequests = [];

function sendJson(res, status, body, contentType = 'application/vnd.schemaregistry.v1+json') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(JSON.stringify(body));
}

let pool;
let emergencyRepository;
let eventosProcesadosRepo;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    registryRequests.push(`${req.method} ${req.url}`);
    const match = /^\/schemas\/ids\/(\d+)$/.exec(req.url);
    const id = match ? Number(match[1]) : null;

    if (req.method === 'GET' && id === SCHEMA_ID_OK) {
      sendJson(res, 200, { schema: JSON.stringify(EVENTO_COMUNITARIO_PUBLICADO_SCHEMA) });
    } else if (req.method === 'GET' && id === SCHEMA_ID_UNAVAILABLE) {
      sendJson(res, 503, { error_code: 50301, message: 'Registry no disponible' });
    } else {
      sendJson(res, 404, { error_code: 40403, message: 'Schema not found' });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  registryUrl = `http://127.0.0.1:${server.address().port}`;

  pool = getPool();
  emergencyRepository = new EmergencyRepository(pool);
  eventosProcesadosRepo = new EventosProcesadosRepository(pool);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM emergencies WHERE causa_tipo = 'EVENTO_PUBLICO' AND causa_id = ANY($1::text[])",
    [usedEventoIds]
  );
  await pool.query('DELETE FROM outbox_events WHERE topic = $1', [CREATED_TOPIC]);
  await pool.query("DELETE FROM contexto_zona WHERE origen = 'espacios'");
  await pool.query('DELETE FROM eventos_procesados WHERE event_id = ANY($1::uuid[])', [usedEventIds]);
  await pool.end();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  registryRequests.length = 0;
});

// Listener armado como en src/index.js: decoder con el registry de
// EDA_SCHEMA_REGISTRY_URL y OutcomeFactory con dedup.
function createListener() {
  const factory = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
  factory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  factory.register(REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler({ contextoZonaRepository: new ContextoZonaRepository(pool) }));
  const decoder = createEventDecoder({ registry: registryFromEnv({ EDA_SCHEMA_REGISTRY_URL: registryUrl }) });
  return new EventoComunitarioPublicadoListener(fakeKafka(), { factory, decoder });
}

async function coberturasDe(eventoId) {
  const { rows } = await pool.query(
    "SELECT * FROM emergencies WHERE causa_tipo = 'EVENTO_PUBLICO' AND causa_id = $1",
    [eventoId]
  );
  return rows;
}

describe('consumer con Avro en formato Confluent (registry HTTP local)', () => {
  it('decodifica contra el registry, crea la emergencia PREVENTIVA y registra el evento como procesado', async () => {
    const event = publicado();
    const message = confluentMessage(SCHEMA_ID_OK, event);
    expect(message.value[0]).toBe(0x00);
    expect(message.value.readInt32BE(1)).toBe(SCHEMA_ID_OK);

    const outcomes = await createListener().onMessage(message);

    expect(registryRequests).toContain(`GET /schemas/ids/${SCHEMA_ID_OK}`);
    expect(outcomes.map((outcome) => outcome.type)).toEqual([PROGRAMAR_COBERTURA, REGISTRAR_CONTEXTO_ZONA]);

    const rows = await coberturasDe(event.data.eventoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      emergency_type: 'PREVENTIVA',
      severity: 'low',
      source: 'EXTERNAL',
      causa_tipo: 'EVENTO_PUBLICO',
      causa_id: event.data.eventoId,
      user_id: null,
      requires_manual_validation: false,
    });

    // Los double de Avro llegan intactos hasta la ubicación cifrada.
    const emergency = await emergencyRepository.findById(rows[0].id);
    expect(emergency.latitude).toBeCloseTo(event.data.latitud, 6);
    expect(emergency.longitude).toBeCloseTo(event.data.longitud, 6);
    expect(emergency.address).toBe(event.data.direccion);

    expect(await eventosProcesadosRepo.findById(event.metadata.eventId)).toMatchObject({
      status: 'PROCESSED',
      source: 'grupo7',
      eventType: 'com.citypass.espacios.EventoComunitarioPublicado',
      discardReason: null,
    });

    const outbox = await pool.query(
      "SELECT payload FROM outbox_events WHERE topic = $1 AND payload->'data'->>'emergenciaId' = $2",
      [CREATED_TOPIC, rows[0].id]
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({
      type: 'EmergenciaCreada',
      data: { categoria: 'PREVENTIVA', causaTipo: 'EVENTO_PUBLICO', causaId: event.data.eventoId, ciudadanoId: null },
    });
  });

  it('una unión Avro en null (sin coordenadas) se lee como null y queda para validación manual', async () => {
    const event = publicado({ latitud: null, longitud: null });

    await createListener().onMessage(confluentMessage(SCHEMA_ID_OK, event));

    const [cobertura] = await coberturasDe(event.data.eventoId);
    expect(cobertura.requires_manual_validation).toBe(true);
    expect(cobertura.location_encrypted).toBeNull();
  });

  it('si el registry responde 404 el mensaje se descarta: el offset avanza y no se escribe nada', async () => {
    const event = publicado();

    await expect(createListener().onMessage(confluentMessage(SCHEMA_ID_NOT_FOUND, event))).resolves.toBeNull();

    expect(registryRequests).toContain(`GET /schemas/ids/${SCHEMA_ID_NOT_FOUND}`);
    expect(await coberturasDe(event.data.eventoId)).toHaveLength(0);
    // Sin poder leer el mensaje no hay eventId para registrar el descarte.
    expect(await eventosProcesadosRepo.findById(event.metadata.eventId)).toBeNull();
  });

  it('si el registry responde 503 el error es transitorio: se relanza para que Kafka reentregue y no se escribe nada', async () => {
    const event = publicado();

    await expect(createListener().onMessage(confluentMessage(SCHEMA_ID_UNAVAILABLE, event)))
      .rejects.toMatchObject({ status: 503, transient: true });

    expect(registryRequests).toContain(`GET /schemas/ids/${SCHEMA_ID_UNAVAILABLE}`);
    expect(await coberturasDe(event.data.eventoId)).toHaveLength(0);
    expect(await eventosProcesadosRepo.findById(event.metadata.eventId)).toBeNull();
  });
});
