// Test de integracion del consumer (issue #65, ADR #25).
// Kafka no corre en este test: se llama directamente a EventListener.onMessage()
// con un mensaje serializado. El DB es real (levantado por global-setup.js).
// Valida de punta a punta: OutcomeFactory + dedup + cobertura preventiva por el
// repositorio (emergencia, outbox e historial), la cancelacion y los descartes.

const { getPool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');
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
const { ContextoZonaRepository } = require('../../repositories/contexto-zona.repository');
const { createLocationCrypto } = require('../../security/location-crypto');

const CREATED_TOPIC = 'test.emergencias.creada';
const UPDATED_TOPIC = 'test.emergencias.actualizada';

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
let publicado;
let cancelado;

beforeAll(() => {
  pool = getPool();
  emergencyRepository = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto() });
  eventosProcesadosRepo = new EventosProcesadosRepository(pool);

  outcomeFactory = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
  outcomeFactory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({ emergencyRepository, topic: CREATED_TOPIC }));
  outcomeFactory.register(CANCELAR_COBERTURA, createCancelarCoberturaHandler({ emergencyRepository, topic: UPDATED_TOPIC }));
  const contextoZonaRepository = new ContextoZonaRepository(pool);
  outcomeFactory.register(REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler({ contextoZonaRepository }));
  outcomeFactory.register(DAR_DE_BAJA_CONTEXTO_ZONA, createDarDeBajaContextoZonaHandler({ contextoZonaRepository }));

  publicado = new EventoComunitarioPublicadoListener(fakeKafka(), { factory: outcomeFactory });
  cancelado = new EventoCanceladoListener(fakeKafka(), { factory: outcomeFactory });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM eventos_procesados');
  await pool.query('DELETE FROM contexto_zona');
  await pool.query(
    "DELETE FROM emergency_status_history WHERE emergency_id IN (SELECT id FROM emergencies WHERE source = 'EXTERNAL')"
  );
  await pool.query("DELETE FROM emergencies WHERE source = 'EXTERNAL'");
  await pool.query('DELETE FROM outbox_events WHERE topic IN ($1, $2)', [CREATED_TOPIC, UPDATED_TOPIC]);
});

const PUBLICADO = {
  metadata: {
    eventId: 'a1000000-0000-4000-8000-000000000001',
    eventType: 'com.citypass.espacios.EventoComunitarioPublicado',
    source: 'grupo7',
  },
  data: {
    eventoId: 'ev-1500',
    titulo: 'Feria del Libro 2026',
    capacidad: 1500,
    latitud: -34.615,
    longitud: -58.371,
    direccion: 'Av. Sarmiento 2704',
    estado: 'ACTIVE',
    correlationId: 'evento-ev-1500',
  },
};

function cancelacion(eventId, eventoId = PUBLICADO.data.eventoId) {
  return {
    metadata: { eventId, eventType: 'com.citypass.espacios.EventoCancelado', source: 'grupo7' },
    data: { eventoId, motivo: 'texto libre del organizador', canceladoEn: '2026-11-05T12:00:00.000Z' },
  };
}

async function coberturas() {
  const { rows } = await pool.query(
    "SELECT * FROM emergencies WHERE source = 'EXTERNAL' AND causa_id = $1 ORDER BY created_at",
    [PUBLICADO.data.eventoId]
  );
  return rows;
}

describe('cobertura preventiva (integration)', () => {
  it('crea una emergencia PREVENTIVA EXTERNAL con causa, sin ciudadano y con ubicación cifrada', async () => {
    await publicado.onMessage(buildMessage(PUBLICADO));

    const rows = await coberturas();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      emergency_type: 'PREVENTIVA',
      severity: 'low',
      source: 'EXTERNAL',
      causa_tipo: 'EVENTO_PUBLICO',
      causa_id: 'ev-1500',
      user_id: null,
      requires_manual_validation: false,
    });
    expect(rows[0].location_encrypted).not.toBeNull();
    // El correlationId de Espacios no es UUID: la emergencia usa su propio id.
    expect(rows[0].correlation_id).toBe(rows[0].id);
  });

  it('encola EmergenciaCreada con el contrato del #48 en la misma transacción', async () => {
    await publicado.onMessage(buildMessage(PUBLICADO));
    const [cobertura] = await coberturas();

    const { rows } = await pool.query('SELECT payload FROM outbox_events WHERE topic = $1', [CREATED_TOPIC]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.type).toBe('EmergenciaCreada');
    expect(rows[0].payload.data).toMatchObject({
      emergenciaId: cobertura.id,
      categoria: 'PREVENTIVA',
      prioridad: 'BAJA',
      estado: 'PENDIENTE',
      causaTipo: 'EVENTO_PUBLICO',
      causaId: 'ev-1500',
      ciudadanoId: null,
    });
  });

  it('registra el evento como procesado', async () => {
    await publicado.onMessage(buildMessage(PUBLICADO));
    const row = await eventosProcesadosRepo.findById(PUBLICADO.metadata.eventId);
    expect(row).toMatchObject({ status: 'PROCESSED', eventType: PUBLICADO.metadata.eventType });
  });

  it('la reentrega del mismo eventId no hace nada', async () => {
    await publicado.onMessage(buildMessage(PUBLICADO));
    await publicado.onMessage(buildMessage(PUBLICADO));
    expect(await coberturas()).toHaveLength(1);
  });

  it('una republicación del evento (otro eventId, cambian los inscriptos) no duplica la cobertura', async () => {
    await publicado.onMessage(buildMessage(PUBLICADO));
    await publicado.onMessage(buildMessage({
      metadata: { ...PUBLICADO.metadata, eventId: 'a1000000-0000-4000-8000-000000000002' },
      data: { ...PUBLICADO.data, inscriptos: 40 },
    }));

    expect(await coberturas()).toHaveLength(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM outbox_events WHERE topic = $1', [CREATED_TOPIC]);
    expect(rows[0].n).toBe(1);
  });

  it('sin coordenadas queda para validación manual', async () => {
    await publicado.onMessage(buildMessage({
      metadata: { ...PUBLICADO.metadata, eventId: 'a1000000-0000-4000-8000-000000000003' },
      data: { ...PUBLICADO.data, latitud: null, longitud: null },
    }));
    const [cobertura] = await coberturas();
    expect(cobertura.requires_manual_validation).toBe(true);
    expect(cobertura.location_encrypted).toBeNull();
  });

  it('un evento chico no crea cobertura', async () => {
    await publicado.onMessage(buildMessage({
      metadata: { ...PUBLICADO.metadata, eventId: 'a1000000-0000-4000-8000-000000000004' },
      data: { ...PUBLICADO.data, capacidad: 100 },
    }));
    expect(await coberturas()).toHaveLength(0);
  });

  it('EventoCancelado cancela la cobertura con historial y EmergenciaActualizada', async () => {
    await publicado.onMessage(buildMessage(PUBLICADO));
    await cancelado.onMessage(buildMessage(cancelacion('b1000000-0000-4000-8000-000000000001')));

    const [cobertura] = await coberturas();
    expect(cobertura.status).toBe('CANCELLED');

    const history = await pool.query(
      'SELECT previous_status, new_status, actor, reason FROM emergency_status_history WHERE emergency_id = $1',
      [cobertura.id]
    );
    expect(history.rows).toEqual([{
      previous_status: 'PENDING',
      new_status: 'CANCELLED',
      actor: 'eda:espacios',
      reason: 'Evento comunitario cancelado',
    }]);

    const outbox = await pool.query('SELECT payload FROM outbox_events WHERE topic = $1', [UPDATED_TOPIC]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload.type).toBe('EmergenciaActualizada');
    expect(outbox.rows[0].payload.data).toMatchObject({
      emergenciaId: cobertura.id,
      estadoAnterior: 'PENDIENTE',
      estadoNuevo: 'CANCELADA',
    });
    // El motivo del organizador es texto libre: no viaja.
    expect(JSON.stringify(outbox.rows[0].payload)).not.toContain('texto libre del organizador');
  });

  it('no cancela una cobertura que ya fue despachada', async () => {
    await publicado.onMessage(buildMessage(PUBLICADO));
    const [cobertura] = await coberturas();
    await pool.query("UPDATE emergencies SET status = 'DISPATCHED' WHERE id = $1", [cobertura.id]);

    await cancelado.onMessage(buildMessage(cancelacion('b1000000-0000-4000-8000-000000000002')));

    const [despues] = await coberturas();
    expect(despues.status).toBe('DISPATCHED');
  });
});

describe('errores del consumer (integration)', () => {
  it('un error permanente queda DISCARDED con el motivo y no se reentrega', async () => {
    // Factory sin handler para CancelarCobertura: "type sin handler" es permanente.
    const sinHandler = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
    const listener = new EventoCanceladoListener(fakeKafka(), { factory: sinHandler });
    const evento = cancelacion('c1000000-0000-4000-8000-000000000001');

    await expect(listener.onMessage(buildMessage(evento))).resolves.toBeNull();

    const row = await eventosProcesadosRepo.findById(evento.metadata.eventId);
    expect(row.status).toBe('DISCARDED');
    expect(row.discardReason).toMatch(/No hay un handler registrado para CancelarCobertura/);

    // Una reentrega tampoco lanza: el offset avanza.
    await expect(listener.onMessage(buildMessage(evento))).resolves.toBeNull();
  });

  it('un error transitorio se relanza para que Kafka reentregue, sin dejar nada escrito', async () => {
    const fallaDeBase = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
    fallaDeBase.register(CANCELAR_COBERTURA, async () => {
      throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    });
    fallaDeBase.register(DAR_DE_BAJA_CONTEXTO_ZONA, async () => {});
    const listener = new EventoCanceladoListener(fakeKafka(), { factory: fallaDeBase });
    const evento = cancelacion('c1000000-0000-4000-8000-000000000002');

    await expect(listener.onMessage(buildMessage(evento))).rejects.toThrow(/administrator command/);
    expect(await eventosProcesadosRepo.findById(evento.metadata.eventId)).toBeNull();
  });

  it('un eventId que no es UUID se descarta sin lanzar, sin abrir la transacción ni escribir nada', async () => {
    const evento = {
      metadata: { ...PUBLICADO.metadata, eventId: 'timeout-no-es-uuid' },
      data: PUBLICADO.data,
    };

    await expect(publicado.onMessage(buildMessage(evento))).resolves.toBeNull();
    // La reentrega tampoco lanza: el offset avanza.
    await expect(publicado.onMessage(buildMessage(evento))).resolves.toBeNull();

    expect(await coberturas()).toHaveLength(0);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM eventos_procesados');
    expect(rows[0].n).toBe(0);
  });

  it('un 22P02 de Postgres es permanente aunque el mensaje diga "timeout": queda DISCARDED', async () => {
    const datoInvalido = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
    datoInvalido.register(CANCELAR_COBERTURA, async (client) => {
      // Error real de Postgres: invalid input syntax for type uuid: "timeout-123"
      await client.query('SELECT $1::uuid', ['timeout-123']);
    });
    datoInvalido.register(DAR_DE_BAJA_CONTEXTO_ZONA, async () => {});
    const listener = new EventoCanceladoListener(fakeKafka(), { factory: datoInvalido });
    const evento = cancelacion('c1000000-0000-4000-8000-000000000003');

    await expect(listener.onMessage(buildMessage(evento))).resolves.toBeNull();

    const row = await eventosProcesadosRepo.findById(evento.metadata.eventId);
    expect(row.status).toBe('DISCARDED');
    expect(row.discardReason).toMatch(/invalid input syntax for type uuid: "timeout-123"/);
  });

  it('un mensaje ilegible se descarta sin lanzar', async () => {
    await expect(publicado.onMessage({ value: Buffer.from('no-es-json') })).resolves.toBeNull();
  });
});
