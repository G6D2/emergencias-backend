// Contrato de los eventos del outbox (issue #48 de demo-repository) como
// JSON Schema en docs/contratos/*.schema.json, validado con ajv contra las
// filas REALES que dejan en outbox_events el ciclo completo por HTTP, las
// ramas cancel/discard/return y una cobertura preventiva del listener.
//
// Si alguien agrega, saca o renombra un campo en src/services/emergency-events.js
// sin actualizar el schema (o al revés), esta suite falla.

const path = require('path');
const { randomUUID } = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { getPool, closePool } = require('../db/pool');
const {
  STATUS_TO_ESTADO,
  SEVERITY_TO_PRIORIDAD,
  buildEmergencyCreatedEvent,
  buildEmergencyUpdatedEvent,
} = require('../services/emergency-events');
const { EMERGENCY_TYPES } = require('../domain/emergency-type');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { EventosProcesadosRepository } = require('../repositories/eventos-procesados.repository');
const { OutcomeFactory } = require('../listeners/outcome-factory');
const { EventoComunitarioPublicadoListener } = require('../listeners/cobertura-preventiva/evento-comunitario-publicado/evento-comunitario-publicado.listener');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler } = require('../listeners/cobertura-preventiva/handlers/contexto-zona.handler');
const { ContextoZonaRepository } = require('../repositories/contexto-zona.repository');
const { createLifecycleHarness, OFFICER_ID } = require('./helpers/emergency-lifecycle');

const CONTRATOS_DIR = path.resolve(__dirname, '..', '..', 'docs', 'contratos');
const creadaSchema = require(path.join(CONTRATOS_DIR, 'emergencia-creada.schema.json'));
const actualizadaSchema = require(path.join(CONTRATOS_DIR, 'emergencia-actualizada.schema.json'));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validators = {
  EmergenciaCreada: ajv.compile(creadaSchema),
  EmergenciaActualizada: ajv.compile(actualizadaSchema),
};

function contractErrors(payload) {
  const validate = validators[payload && payload.type];
  if (!validate) return [`type fuera del contrato: ${payload && payload.type}`];
  if (validate(payload)) return [];
  return validate.errors.map((error) => `${payload.type}${error.instancePath} ${error.message} ${JSON.stringify(error.params)}`);
}

const sortedValues = (object) => [...new Set(Object.values(object))].sort();

// Eventos armados con el builder real a partir de una emergencia de ejemplo,
// para los casos negativos (mutar un evento válido y ver que el schema lo frena).
const SAMPLE_EMERGENCY = {
  id: '7b0d7b3e-6a4f-4a5e-9a59-1f6f1c1b2a3c',
  correlationId: '7b0d7b3e-6a4f-4a5e-9a59-1f6f1c1b2a3c',
  userId: 'CIT-001',
  emergencyType: 'MEDICA',
  severity: 'high',
  status: 'PENDING',
  assignedOfficerId: 'of-001',
  createdAt: new Date('2026-11-05T12:00:00.000Z'),
  updatedAt: new Date('2026-11-05T12:05:00.000Z'),
};
const json = (value) => JSON.parse(JSON.stringify(value));
const sampleCreada = () => json(buildEmergencyCreatedEvent(SAMPLE_EMERGENCY, randomUUID()));
const sampleActualizada = (previousStatus, newStatus) => json(buildEmergencyUpdatedEvent({
  emergency: { ...SAMPLE_EMERGENCY, status: newStatus },
  history: { previousStatus, newStatus },
  actor: 'DISP-001',
  reason: null,
  eventId: randomUUID(),
}));

describe('schemas de docs/contratos', () => {
  it('cada campo de data es obligatorio (los opcionales van como null, no ausentes)', () => {
    for (const schema of [creadaSchema, actualizadaSchema]) {
      const { data } = schema.properties;
      expect([...data.required].sort()).toEqual(Object.keys(data.properties).sort());
      expect(data.additionalProperties).toBe(false);
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it('los enums siguen a las tablas de traducción y al catálogo del código', () => {
    expect([...actualizadaSchema.definitions.estado.enum].sort()).toEqual(sortedValues(STATUS_TO_ESTADO));
    expect([...creadaSchema.definitions.prioridad.enum].sort()).toEqual(sortedValues(SEVERITY_TO_PRIORIDAD));
    expect(actualizadaSchema.properties.data.properties.prioridad.enum.filter(Boolean).sort())
      .toEqual(sortedValues(SEVERITY_TO_PRIORIDAD));
    expect(creadaSchema.properties.data.properties.categoria.enum).toEqual(expect.arrayContaining([...EMERGENCY_TYPES]));
  });

  it('el builder real produce eventos válidos', () => {
    expect(contractErrors(sampleCreada())).toEqual([]);
    for (const [from, to] of Object.entries({
      PENDING: 'VALIDATED', VALIDATED: 'DISPATCHED', ON_SCENE: 'RESOLVED', RESOLVED: 'CLOSED',
    })) {
      expect(contractErrors(sampleActualizada(from, to))).toEqual([]);
    }
  });

  it.each([
    ['un campo de más en data', (e) => { e.data.descripcion = 'texto libre'; }],
    ['un campo de más en el sobre', (e) => { e.metadata = {}; }],
    ['un campo obligatorio ausente', (e) => { delete e.data.barrio; }],
    ['categoria con el alias en inglés', (e) => { e.data.categoria = 'medical'; }],
    ['prioridad en inglés', (e) => { e.data.prioridad = 'high'; }],
    ['createdAt con offset en vez de UTC', (e) => { e.data.createdAt = '2026-11-05T09:00:00-03:00'; }],
    ['createdAt en milisegundos', (e) => { e.data.createdAt = 1762344000000; }],
    ['causaTipo sin causaId', (e) => { e.data.causaTipo = 'EVENTO_PUBLICO'; }],
    ['prioridadOriginal sin EVENTO_CLIMATICO', (e) => { e.data.prioridadOriginal = 'ALTA'; }],
    ['EVENTO_CLIMATICO sin prioridadOriginal', (e) => { e.data.causaId = 'clima-1'; e.data.causaTipo = 'EVENTO_CLIMATICO'; }],
    ['eventId que no es uuid', (e) => { e.eventId = 'evt-1'; }],
  ])('EmergenciaCreada rechaza %s', (label, mutate) => {
    const event = sampleCreada();
    mutate(event);
    expect(contractErrors(event)).not.toEqual([]);
  });

  it.each([
    ['asignadoA fuera de DESPACHADA', 'PENDING', 'VALIDATED', (e) => { e.data.asignadoA = 'of-001'; }],
    ['DESPACHADA sin asignadoA', 'VALIDATED', 'DISPATCHED', (e) => { e.data.asignadoA = null; }],
    ['resueltoAt fuera de RESUELTA', 'PENDING', 'VALIDATED', (e) => { e.data.resueltoAt = '2026-11-05T12:00:00.000Z'; }],
    ['RESUELTA sin resueltoAt', 'ON_SCENE', 'RESOLVED', (e) => { e.data.resueltoAt = null; }],
    ['estado en inglés', 'PENDING', 'VALIDATED', (e) => { e.data.estadoNuevo = 'VALIDATED'; }],
    ['estadoAnterior null', 'PENDING', 'VALIDATED', (e) => { e.data.estadoAnterior = null; }],
    ['un campo de más en data', 'PENDING', 'VALIDATED', (e) => { e.data.newStatus = 'VALIDATED'; }],
  ])('EmergenciaActualizada rechaza %s', (label, from, to, mutate) => {
    const event = sampleActualizada(from, to);
    mutate(event);
    expect(contractErrors(event)).not.toEqual([]);
  });
});

describe('filas reales del outbox contra el contrato', () => {
  let pool;
  let h;
  let rows;
  const tag = randomUUID().slice(0, 8);
  const coberturaEvent = {
    metadata: { eventId: randomUUID(), eventType: 'com.citypass.espacios.EventoComunitarioPublicado', source: 'grupo7' },
    data: {
      eventoId: `ev-contrato-${tag}`,
      titulo: 'Maratón',
      capacidad: 3000,
      latitud: -34.6,
      longitud: -58.4,
      estado: 'ACTIVE',
      correlationId: `evento-ev-contrato-${tag}`,
    },
  };
  const COBERTURA_TOPIC = 'test.contrato.emergencias.creada';

  beforeAll(async () => {
    pool = getPool();
    h = await createLifecycleHarness(pool);
    await h.resetOfficers();

    // Ciclo completo + las tres ramas: cubre todos los estados del contrato.
    const { id: completa } = await h.runFullLifecycle();

    const cancelada = await h.createPending();
    await h.patch(cancelada, 'cancel', 'citizen', { reason: 'falsa alarma' }).expect(200);

    const descartada = await h.createPending();
    await h.patch(descartada, 'discard', 'dispatcher', { reason: 'duplicada' }).expect(200);

    const devuelta = await h.createDispatched(OFFICER_ID);
    await h.patch(devuelta, 'return', 'dispatcher', { reason: 'reasignar' }).expect(200);

    // Alta externa: cobertura preventiva del listener (sin ciudadano, con causa).
    const factory = new OutcomeFactory(pool, { dedupRepo: new EventosProcesadosRepository(pool) });
    factory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({
      emergencyRepository: new EmergencyRepository(pool),
      topic: COBERTURA_TOPIC,
    }));
    factory.register(REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler({
      contextoZonaRepository: new ContextoZonaRepository(pool),
    }));
    const listener = new EventoComunitarioPublicadoListener({ consumer: jest.fn() }, { factory });
    await listener.onMessage({ value: Buffer.from(JSON.stringify(coberturaEvent)) });

    const result = await pool.query(
      `SELECT id, topic, payload FROM outbox_events
       WHERE payload->'data'->>'emergenciaId' = ANY($1::text[]) OR topic = $2
       ORDER BY created_at, id`,
      [[completa, cancelada, descartada, devuelta], COBERTURA_TOPIC]
    );
    rows = result.rows;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM emergencies WHERE causa_tipo = 'EVENTO_PUBLICO' AND causa_id = $1", [coberturaEvent.data.eventoId]);
    await pool.query('DELETE FROM outbox_events WHERE topic = $1', [COBERTURA_TOPIC]);
    await pool.query('DELETE FROM contexto_zona WHERE referencia_externa = $1', [coberturaEvent.data.eventoId]);
    await pool.query('DELETE FROM eventos_procesados WHERE event_id = $1', [coberturaEvent.metadata.eventId]);
    await h.cleanup();
    await closePool();
  });

  it('hay filas de los dos tipos, incluida la EmergenciaCreada externa', () => {
    const creadas = rows.filter((row) => row.payload.type === 'EmergenciaCreada');
    const actualizadas = rows.filter((row) => row.payload.type === 'EmergenciaActualizada');

    // 4 altas por HTTP + 1 cobertura; 6 transiciones del ciclo + cancel + discard + (validate, assign, return).
    expect(creadas).toHaveLength(5);
    expect(actualizadas).toHaveLength(11);
    expect(creadas.some((row) => row.payload.data.categoria === 'PREVENTIVA' && row.payload.data.ciudadanoId === null)).toBe(true);
  });

  it('cada estado de destino del contrato aparece en al menos una fila real', () => {
    const estados = new Set(rows
      .filter((row) => row.payload.type === 'EmergenciaActualizada')
      .map((row) => row.payload.data.estadoNuevo));

    expect([...estados].sort()).toEqual(sortedValues(STATUS_TO_ESTADO).filter((estado) => estado !== 'PENDIENTE'));
  });

  it('todas las filas cumplen su JSON Schema', () => {
    const errors = rows.flatMap((row) => contractErrors(row.payload).map((error) => `${row.id}: ${error}`));
    expect(errors).toEqual([]);
  });

  it('el correlationId del sobre coincide con el de data y el eventId con la fila', () => {
    for (const row of rows) {
      expect(row.payload.data.correlationId).toBe(row.payload.correlationId);
      expect(row.payload.eventId).toBe(row.id);
    }
  });
});
