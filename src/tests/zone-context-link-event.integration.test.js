// EmergenciaVinculadaAContextoZona contra Postgres real (ADR "Publicar el
// vínculo de una emergencia con un contexto de zona"): la fila del vínculo y
// su evento del outbox salen juntos, un reintento no duplica, PANICO se
// vincula sin evento, el backfill es idempotente y la anonimización borra
// el vínculo y su evento. Valida los payloads contra el JSON Schema.

const { randomUUID } = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { getPool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { createLocationCrypto } = require('../security/location-crypto');
const { ZONE_CONTEXT_LINK_EVENT_TYPE } = require('../services/emergency-events');
const schema = require('../../docs/contratos/emergencia-vinculada-a-contexto-zona.schema.json');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const TOPIC = 'test.vinculo.emergencias.vinculada-contexto-zona';
const ON = { EVENTO_VINCULO_CONTEXTO_ENABLED: 'true', TOPIC_EMERGENCIA_VINCULADA_CONTEXTO: TOPIC };

// Rosedal y un punto a ~330 m; el Obelisco queda a más de 4 km.
const ROSEDAL = { latitude: -34.5711, longitude: -58.4167 };
const CERCA = { latitude: -34.5740, longitude: -58.4160 };
const OBELISCO = { latitude: -34.6037, longitude: -58.3816 };

let pool;
let repo;
let contextoId;
let referenciaExterna;
const emergencyIds = [];

async function crearContexto() {
  referenciaExterna = `ev-vinculo-${randomUUID().slice(0, 8)}`;
  const { rows } = await pool.query(
    `INSERT INTO contexto_zona
       (tipo, origen, referencia_externa, latitud, longitud, radio_metros,
        vigente_desde, vigente_hasta, source_updated_at)
     VALUES ('EVENTO_ESPACIO_PUBLICO', 'espacios', $1, $2, $3, 500,
             now() - interval '1 hour', now() + interval '2 hours', now())
     RETURNING id`,
    [referenciaExterna, ROSEDAL.latitude, ROSEDAL.longitude]
  );
  return rows[0].id;
}

async function crearEmergencia(ubicacion, emergencyType = 'MEDICA', repository = repo) {
  const id = randomUUID();
  emergencyIds.push(id);
  await repository.create({
    id,
    userId: 'CIT-vinculo',
    ...ubicacion,
    severity: 'medium',
    emergencyType,
    status: 'PENDING',
  });
  return id;
}

async function eventosDe(emergencyId) {
  const { rows } = await pool.query(
    `SELECT id, topic, status, payload FROM outbox_events
     WHERE payload->>'type' = $1 AND payload->'data'->>'emergenciaId' = $2`,
    [ZONE_CONTEXT_LINK_EVENT_TYPE, emergencyId]
  );
  return rows;
}

async function vinculosDe(emergencyId) {
  const { rows } = await pool.query(
    'SELECT contexto_id, created_at FROM emergencia_contexto_zona WHERE emergency_id = $1',
    [emergencyId]
  );
  return rows;
}

beforeAll(async () => {
  pool = getPool();
  repo = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto(), env: ON });
  contextoId = await crearContexto();
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM outbox_events WHERE payload->'data'->>'emergenciaId' = ANY($1::text[])
       OR payload->'data'->>'id' = ANY($1::text[])`,
    [emergencyIds]
  );
  await pool.query('DELETE FROM emergencies WHERE id = ANY($1::uuid[])', [emergencyIds]);
  await pool.query('DELETE FROM contexto_zona WHERE id = $1', [contextoId]);
});

describe('EmergenciaVinculadaAContextoZona (Postgres real)', () => {
  it('al crear una emergencia cerca, el vínculo y su evento quedan en la base', async () => {
    const id = await crearEmergencia(CERCA);

    const vinculos = await vinculosDe(id);
    expect(vinculos.map((v) => v.contexto_id)).toEqual([contextoId]);

    const eventos = await eventosDe(id);
    expect(eventos).toHaveLength(1);
    const [{ id: outboxId, topic, status, payload }] = eventos;
    expect(topic).toBe(TOPIC);
    expect(status).toBe('PENDING');
    expect(payload.eventId).toBe(outboxId);
    expect(validate(payload)).toBe(true);
    expect(payload.data).toMatchObject({
      emergenciaId: id,
      contextoId,
      contextoTipo: 'EVENTO_ESPACIO_PUBLICO',
      contextoOrigen: 'espacios',
      referenciaExterna,
      radioMetros: 500,
      reglaVersion: 1,
      backfill: false,
    });
    expect(new Date(payload.data.vinculadaEn).getTime()).toBe(vinculos[0].created_at.getTime());
  });

  it('volver a vincular la misma emergencia no duplica el evento', async () => {
    const id = await crearEmergencia(CERCA);
    await repo.linkZoneContexts(pool, { id, ...CERCA, emergencyType: 'MEDICA' });

    expect(await vinculosDe(id)).toHaveLength(1);
    expect(await eventosDe(id)).toHaveLength(1);
  });

  it('lejos del contexto no hay vínculo ni evento', async () => {
    const id = await crearEmergencia(OBELISCO);
    expect(await vinculosDe(id)).toHaveLength(0);
    expect(await eventosDe(id)).toHaveLength(0);
  });

  it('una PANICO se vincula (eleva) pero no publica el vínculo', async () => {
    const id = await crearEmergencia(CERCA, 'PANICO');
    expect(await vinculosDe(id)).toHaveLength(1);
    expect(await eventosDe(id)).toHaveLength(0);
  });

  it('con el evento apagado se vincula igual y el backfill lo recupera una sola vez', async () => {
    const apagado = new EmergencyRepository(pool, { locationCrypto: createLocationCrypto(), env: {} });
    const id = await crearEmergencia(CERCA, 'MEDICA', apagado);
    expect(await vinculosDe(id)).toHaveLength(1);
    expect(await eventosDe(id)).toHaveLength(0);

    const primera = await repo.enqueueMissingZoneContextLinkEvents();
    expect(primera.enqueuedCount).toBeGreaterThanOrEqual(1);
    const eventos = await eventosDe(id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0].topic).toBe(TOPIC);
    expect(eventos[0].payload.data.backfill).toBe(true);
    expect(validate(eventos[0].payload)).toBe(true);

    const segunda = await repo.enqueueMissingZoneContextLinkEvents();
    expect(segunda.enqueuedCount).toBe(0);
    expect(await eventosDe(id)).toHaveLength(1);
  });

  it('al anonimizar se borran el vínculo y su evento del outbox', async () => {
    const id = await crearEmergencia(CERCA);
    expect(await eventosDe(id)).toHaveLength(1);

    await repo.unlinkZoneContexts([id]);

    expect(await vinculosDe(id)).toHaveLength(0);
    expect(await eventosDe(id)).toHaveLength(0);
  });
});
