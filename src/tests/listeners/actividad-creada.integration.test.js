// Integracion de ActividadCreada.v2 (Espacios) con la cobertura preventiva.
// Kafka no corre: se llama a EventListener.onMessage() con el mensaje serializado.
// El DB es real (global-setup.js). Verifica que, como Espacios publica
// EventoComunitarioPublicado y despues ActividadCreada con el mismo id, haya
// una sola cobertura, y que la cancelacion llegue a la que creo ActividadCreada.

const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
const { OutcomeFactory } = require('../../listeners/outcome-factory');
const { EventoComunitarioPublicadoListener } = require('../../listeners/cobertura-preventiva/evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { EventoCanceladoListener } = require('../../listeners/cobertura-preventiva/evento-cancelado/evento-cancelado.listener');
const { ActividadCreadaListener } = require('../../listeners/cobertura-preventiva/actividad-creada/actividad-creada.listener');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { CANCELAR_COBERTURA, createCancelarCoberturaHandler } = require('../../listeners/cobertura-preventiva/handlers/cancelar-cobertura.handler');
const { createLocationCrypto } = require('../../security/location-crypto');

const CREATED_TOPIC = 'test.actividad.creada';
const UPDATED_TOPIC = 'test.actividad.actualizada';
const ACTIVIDAD_ID = 'act-festival-1';

function fakeKafka() {
  return { consumer: jest.fn(() => ({ connect: jest.fn(), subscribe: jest.fn(), run: jest.fn(), disconnect: jest.fn() })) };
}

const buildMessage = (eventObject) => ({ value: Buffer.from(JSON.stringify(eventObject)) });

let pool;
let eventosProcesadosRepo;
let publicado;
let cancelado;
let actividad;

beforeAll(() => {
  pool = getPool();
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  eventosProcesadosRepo = new EventosProcesadosRepository(pool);
  const factory = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
  factory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  factory.register(CANCELAR_COBERTURA, createCancelarCoberturaHandler({ emergencyRepository, topic: UPDATED_TOPIC }));

  publicado = new EventoComunitarioPublicadoListener(fakeKafka(), { factory });
  cancelado = new EventoCanceladoListener(fakeKafka(), { factory });
  actividad = new ActividadCreadaListener(fakeKafka(), { factory });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM eventos_procesados');
  await pool.query(
    "DELETE FROM emergency_status_history WHERE emergency_id IN (SELECT id FROM emergencies WHERE source = 'EXTERNAL')"
  );
  await pool.query("DELETE FROM emergencies WHERE source = 'EXTERNAL'");
  await pool.query('DELETE FROM outbox_events WHERE topic IN ($1, $2)', [CREATED_TOPIC, UPDATED_TOPIC]);
});

const COMUNITARIO = {
  metadata: { eventId: 'b2000000-0000-4000-8000-000000000001', eventType: 'com.citypass.espacios.EventoComunitarioPublicado', source: 'grupo7' },
  data: { eventoId: ACTIVIDAD_ID, titulo: 'Festival de Primavera', capacidad: 1200, latitud: -34.5994, longitud: -58.3988, estado: 'ACTIVE' },
};

const ACTIVIDAD = {
  metadata: { eventId: 'b2000000-0000-4000-8000-000000000002', eventType: 'com.citypass.espacios.ActividadCreada', source: 'grupo7' },
  data: {
    actividadId: ACTIVIDAD_ID,
    titulo: 'Festival de Primavera',
    capacidad: 1200,
    estado: 'PROGRAMADA',
    direccion: 'Av. Córdoba 2100',
    correlationId: `act-${ACTIVIDAD_ID}`,
    ubicacion: { lat: -34.5994, lng: -58.3988 },
    fechaHoraInicio: 1763000000000,
    fechaHoraFinalizacion: 1763007200000,
  },
};

async function coberturas() {
  const { rows } = await pool.query(
    "SELECT * FROM emergencies WHERE source = 'EXTERNAL' AND causa_id = $1 ORDER BY created_at",
    [ACTIVIDAD_ID]
  );
  return rows;
}

describe('ActividadCreada.v2 → cobertura preventiva (integration)', () => {
  it('crea la cobertura PREVENTIVA con causa = actividadId', async () => {
    await actividad.onMessage(buildMessage(ACTIVIDAD));

    const rows = await coberturas();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      emergency_type: 'PREVENTIVA',
      source: 'EXTERNAL',
      causa_tipo: 'EVENTO_PUBLICO',
      causa_id: ACTIVIDAD_ID,
      user_id: null,
      requires_manual_validation: false,
    });
    const { rows: outbox } = await pool.query('SELECT payload FROM outbox_events WHERE topic = $1', [CREATED_TOPIC]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.data).toMatchObject({ categoria: 'PREVENTIVA', causaTipo: 'EVENTO_PUBLICO', causaId: ACTIVIDAD_ID });
  });

  it('si llegan los dos eventos (comunitario y luego actividad) queda una sola cobertura', async () => {
    await publicado.onMessage(buildMessage(COMUNITARIO));
    await actividad.onMessage(buildMessage(ACTIVIDAD));

    expect(await coberturas()).toHaveLength(1);
    const { rows: outbox } = await pool.query('SELECT 1 FROM outbox_events WHERE topic = $1', [CREATED_TOPIC]);
    expect(outbox).toHaveLength(1);
  });

  it('el orden inverso tampoco duplica', async () => {
    await actividad.onMessage(buildMessage(ACTIVIDAD));
    await publicado.onMessage(buildMessage(COMUNITARIO));

    expect(await coberturas()).toHaveLength(1);
  });

  it('no crea cobertura por debajo de 1.000 personas', async () => {
    await actividad.onMessage(buildMessage({ ...ACTIVIDAD, data: { ...ACTIVIDAD.data, capacidad: 800 } }));
    expect(await coberturas()).toHaveLength(0);
  });

  it('EventoCancelado cancela la cobertura que creó ActividadCreada', async () => {
    await actividad.onMessage(buildMessage(ACTIVIDAD));
    await cancelado.onMessage(
      buildMessage({
        metadata: { eventId: 'b2000000-0000-4000-8000-000000000003', eventType: 'com.citypass.espacios.EventoCancelado', source: 'grupo7' },
        data: { eventoId: ACTIVIDAD_ID, motivo: 'lluvia', canceladoEn: '2026-11-05T12:00:00.000Z' },
      })
    );

    const rows = await coberturas();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('CANCELLED');
  });
});
