// Evento EmergenciaVinculadaAContextoZona (ADR "Publicar el vínculo de una
// emergencia con un contexto de zona"): builder contra el JSON Schema de
// docs/contratos, reglas de publicación, encolado atómico con el vínculo,
// backfill y borrado al anonimizar.
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schema = require('../../docs/contratos/emergencia-vinculada-a-contexto-zona.schema.json');
const {
  buildEmergencyLinkedToZoneContextEvent,
  shouldPublishZoneContextLink,
  zoneContextLinkTopic,
  ZONE_CONTEXT_LINK_EVENT_TYPE,
  ZONE_CONTEXT_LINK_RULE_VERSION,
  CATEGORIES_WITHOUT_PUBLISHED_LINK,
} = require('../services/emergency-events');
const { EmergencyRepository } = require('../repositories/emergency.repository');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const fakeCrypto = {
  encryptLocation: () => 'cipher',
  decryptLocation: () => ({ latitude: 0, longitude: 0 }),
};
const ON = { EVENTO_VINCULO_CONTEXTO_ENABLED: 'true' };
const OFF = {};

const EMERGENCY_ID = '11111111-1111-4111-8111-111111111111';
const CONTEXTO = {
  id: '22222222-2222-4222-8222-222222222222',
  tipo: 'EVENTO_ESPACIO_PUBLICO',
  origen: 'espacios',
  referenciaExterna: 'evento-espacios-42',
  radioMetros: 500,
};

// Rosedal y un punto a ~330 m.
const ROSEDAL = { latitud: -34.5711, longitud: -58.4167 };
const CERCA = { latitude: -34.5740, longitude: -58.4160 };
const FILA_CONTEXTO = {
  id: CONTEXTO.id, ...ROSEDAL, radio_metros: 500, tipo: CONTEXTO.tipo,
  origen: CONTEXTO.origen, referencia_externa: CONTEXTO.referenciaExterna,
};

function executorCon(contextos) {
  return { query: jest.fn().mockResolvedValueOnce({ rows: contextos }).mockResolvedValue({ rows: [] }) };
}

function repoCon(env, pool = { query: jest.fn(async () => ({ rows: [] })) }) {
  return new EmergencyRepository(pool, { locationCrypto: fakeCrypto, env });
}

describe('buildEmergencyLinkedToZoneContextEvent', () => {
  it('cumple el JSON Schema del contrato y no lleva coordenadas', () => {
    const event = buildEmergencyLinkedToZoneContextEvent({
      emergencyId: EMERGENCY_ID,
      correlationId: EMERGENCY_ID,
      contexto: CONTEXTO,
      vinculadaEn: new Date('2026-11-13T18:04:00Z'),
      eventId: '33333333-3333-4333-8333-333333333333',
    });

    expect(validate(event)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(event).toEqual({
      type: 'EmergenciaVinculadaAContextoZona',
      eventId: '33333333-3333-4333-8333-333333333333',
      correlationId: EMERGENCY_ID,
      data: {
        emergenciaId: EMERGENCY_ID,
        contextoId: CONTEXTO.id,
        contextoTipo: 'EVENTO_ESPACIO_PUBLICO',
        contextoOrigen: 'espacios',
        referenciaExterna: 'evento-espacios-42',
        radioMetros: 500,
        vinculadaEn: '2026-11-13T18:04:00.000Z',
        reglaVersion: ZONE_CONTEXT_LINK_RULE_VERSION,
        backfill: false,
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/latitud|longitud/);
  });

  it('acepta created_at como string de la base y radio como string de numeric', () => {
    const event = buildEmergencyLinkedToZoneContextEvent({
      emergencyId: EMERGENCY_ID,
      contexto: { ...CONTEXTO, radioMetros: '500' },
      vinculadaEn: '2026-11-13 18:04:00+00',
      backfill: true,
      eventId: '33333333-3333-4333-8333-333333333333',
    });
    expect(validate(event)).toBe(true);
    expect(event.correlationId).toBe(EMERGENCY_ID);
    expect(event.data.radioMetros).toBe(500);
    expect(event.data.backfill).toBe(true);
  });
});

describe('shouldPublishZoneContextLink', () => {
  it('solo con EVENTO_VINCULO_CONTEXTO_ENABLED=true', () => {
    expect(shouldPublishZoneContextLink('MEDICA', ON)).toBe(true);
    expect(shouldPublishZoneContextLink('MEDICA', OFF)).toBe(false);
    expect(shouldPublishZoneContextLink('MEDICA', { EVENTO_VINCULO_CONTEXTO_ENABLED: '1' })).toBe(false);
  });

  it('PANICO se publica como el resto: tiene la misma precisión en el bus', () => {
    expect(shouldPublishZoneContextLink('PANICO', ON)).toBe(true);
  });

  it('una categoría excluida no se publica aunque el evento esté encendido', () => {
    CATEGORIES_WITHOUT_PUBLISHED_LINK.add('EXCLUIDA');
    try {
      expect(shouldPublishZoneContextLink('EXCLUIDA', ON)).toBe(false);
    } finally {
      CATEGORIES_WITHOUT_PUBLISHED_LINK.delete('EXCLUIDA');
    }
  });

  it('el topic se puede configurar', () => {
    expect(zoneContextLinkTopic({})).toBe('emergencias.vinculada-contexto-zona');
    expect(zoneContextLinkTopic({ TOPIC_EMERGENCIA_VINCULADA_CONTEXTO: 'otro' })).toBe('otro');
  });
});

describe('EmergencyRepository.linkZoneContexts con el evento encendido', () => {
  it('inserta el vínculo y su evento del outbox en una sola sentencia', async () => {
    const executor = executorCon([FILA_CONTEXTO]);
    const repo = repoCon(ON);

    const ids = await repo.linkZoneContexts(executor, {
      id: EMERGENCY_ID, correlationId: 'corr-1', ...CERCA, emergencyType: 'MEDICA',
    });

    expect(ids).toEqual([CONTEXTO.id]);
    expect(executor.query).toHaveBeenCalledTimes(2);
    const [sql, params] = executor.query.mock.calls[1];
    // El evento solo sale para los vínculos que se insertaron (RETURNING + JOIN).
    expect(sql).toMatch(/WITH nuevos AS \(\s*INSERT INTO emergencia_contexto_zona/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING\s+RETURNING emergency_id, contexto_id/);
    expect(sql).toMatch(/INSERT INTO outbox_events \(id, topic, payload\)/);
    expect(sql).toMatch(/JOIN nuevos ON nuevos\.emergency_id = ev\.emergency_id AND nuevos\.contexto_id = ev\.contexto_id/);

    const [emergencyIds, contextoIds, vinculadaEn, topic, evIds, payloads] = params;
    expect(emergencyIds).toEqual([EMERGENCY_ID]);
    expect(contextoIds).toEqual([CONTEXTO.id]);
    expect(topic).toBe('emergencias.vinculada-contexto-zona');
    const event = JSON.parse(payloads[0]);
    expect(event.eventId).toBe(evIds[0]);
    expect(event.correlationId).toBe('corr-1');
    expect(event.data.vinculadaEn).toBe(vinculadaEn.toISOString());
    expect(event.data.referenciaExterna).toBe('evento-espacios-42');
    expect(validate(event)).toBe(true);
  });

  it('una PANICO se vincula y encola su evento como cualquier otra', async () => {
    const executor = executorCon([FILA_CONTEXTO]);
    const ids = await repoCon(ON).linkZoneContexts(executor, {
      id: EMERGENCY_ID, ...CERCA, emergencyType: 'PANICO',
    });

    expect(ids).toEqual([CONTEXTO.id]);
    expect(executor.query.mock.calls[1][0]).toMatch(/INSERT INTO outbox_events/);
  });

  it('una categoría excluida se vincula igual (eleva) pero sin evento', async () => {
    CATEGORIES_WITHOUT_PUBLISHED_LINK.add('EXCLUIDA');
    try {
      const executor = executorCon([FILA_CONTEXTO]);
      const ids = await repoCon(ON).linkZoneContexts(executor, {
        id: EMERGENCY_ID, ...CERCA, emergencyType: 'EXCLUIDA',
      });

      expect(ids).toEqual([CONTEXTO.id]);
      const [sql, params] = executor.query.mock.calls[1];
      expect(sql).not.toMatch(/outbox_events/);
      expect(params).toEqual([[EMERGENCY_ID], [CONTEXTO.id]]);
    } finally {
      CATEGORIES_WITHOUT_PUBLISHED_LINK.delete('EXCLUIDA');
    }
  });

  it('con el evento apagado no toca el outbox', async () => {
    const executor = executorCon([FILA_CONTEXTO]);
    await repoCon(OFF).linkZoneContexts(executor, { id: EMERGENCY_ID, ...CERCA, emergencyType: 'MEDICA' });
    expect(executor.query.mock.calls[1][0]).not.toMatch(/outbox_events/);
  });
});

describe('EmergencyRepository.linkOpenEmergenciesToZoneContext con el evento encendido', () => {
  const CONTEXTO_BARRIO = {
    id: CONTEXTO.id, tipo: 'ALERTA_CLIMATICA', origen: 'espacios', referenciaExterna: 'alerta-1#0',
    ...ROSEDAL, radioMetros: 3837, barrios: ['PALERMO'],
  };
  const OTRA_ID = '44444444-4444-4444-8444-444444444444';

  it('un evento por emergencia vinculada, en la misma sentencia que los vínculos', async () => {
    const executor = executorCon([
      { id: EMERGENCY_ID, correlation_id: 'corr-1', emergency_type: 'MEDICA' },
      { id: OTRA_ID, correlation_id: 'corr-2', emergency_type: 'PANICO' },
    ]);

    const ids = await repoCon(ON).linkOpenEmergenciesToZoneContext(executor, CONTEXTO_BARRIO);

    expect(ids).toEqual([EMERGENCY_ID, OTRA_ID]);
    expect(executor.query).toHaveBeenCalledTimes(2);
    const [sql, params] = executor.query.mock.calls[1];
    expect(sql).toMatch(/WITH nuevos AS \(\s*INSERT INTO emergencia_contexto_zona/);
    expect(sql).toMatch(/RETURNING emergency_id, contexto_id/);
    const [emergencyIds, contextoIds, vinculadaEn, , evIds, payloads] = params;
    expect(emergencyIds).toEqual([EMERGENCY_ID, OTRA_ID]);
    expect(contextoIds).toEqual([CONTEXTO.id, CONTEXTO.id]);
    const events = payloads.map((payload) => JSON.parse(payload));
    expect(events.map((e) => e.eventId)).toEqual(evIds);
    expect(events.map((e) => e.correlationId)).toEqual(['corr-1', 'corr-2']);
    for (const event of events) {
      expect(event.data).toMatchObject({
        contextoId: CONTEXTO.id,
        contextoTipo: 'ALERTA_CLIMATICA',
        referenciaExterna: 'alerta-1#0',
        radioMetros: 3837,
        vinculadaEn: vinculadaEn.toISOString(),
        backfill: false,
      });
      expect(validate(event)).toBe(true);
    }
  });

  it('una categoría excluida se vincula sin evento y el resto con evento', async () => {
    CATEGORIES_WITHOUT_PUBLISHED_LINK.add('EXCLUIDA');
    try {
      const executor = executorCon([
        { id: EMERGENCY_ID, correlation_id: 'corr-1', emergency_type: 'MEDICA' },
        { id: OTRA_ID, correlation_id: 'corr-2', emergency_type: 'EXCLUIDA' },
      ]);

      await repoCon(ON).linkOpenEmergenciesToZoneContext(executor, CONTEXTO_BARRIO);

      expect(executor.query).toHaveBeenCalledTimes(3);
      const [sinEventoSql, sinEventoParams] = executor.query.mock.calls[1];
      expect(sinEventoSql).not.toMatch(/outbox_events/);
      expect(sinEventoParams).toEqual([[OTRA_ID], [CONTEXTO.id]]);
      const [conEventoSql, conEventoParams] = executor.query.mock.calls[2];
      expect(conEventoSql).toMatch(/INSERT INTO outbox_events/);
      expect(conEventoParams[0]).toEqual([EMERGENCY_ID]);
    } finally {
      CATEGORIES_WITHOUT_PUBLISHED_LINK.delete('EXCLUIDA');
    }
  });
});

describe('EmergencyRepository.enqueueMissingZoneContextLinkEvents (backfill)', () => {
  const filaVinculo = (overrides = {}) => ({
    emergency_id: EMERGENCY_ID,
    contexto_id: CONTEXTO.id,
    created_at: new Date('2026-11-12T10:00:00Z'),
    correlation_id: EMERGENCY_ID,
    emergency_type: 'MEDICA',
    tipo: CONTEXTO.tipo,
    origen: CONTEXTO.origen,
    referencia_externa: CONTEXTO.referenciaExterna,
    radio_metros: 500,
    ...overrides,
  });

  it('encola con backfill: true los vínculos sin evento, PANICO incluida, salvo las categorías excluidas', async () => {
    const pool = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [
            filaVinculo(),
            filaVinculo({ emergency_id: 'e-panico', emergency_type: 'PANICO' }),
            filaVinculo({ emergency_id: 'e-excluida', emergency_type: 'EXCLUIDA' }),
          ],
        })
        .mockResolvedValue({ rows: [] }),
    };

    CATEGORIES_WITHOUT_PUBLISHED_LINK.add('EXCLUIDA');
    let result;
    try {
      result = await repoCon(ON, pool).enqueueMissingZoneContextLinkEvents();
    } finally {
      CATEGORIES_WITHOUT_PUBLISHED_LINK.delete('EXCLUIDA');
    }

    expect(result).toEqual({ enqueuedCount: 2, skippedCount: 1 });
    const [selectSql, selectParams] = pool.query.mock.calls[0];
    expect(selectSql).toMatch(/NOT EXISTS/);
    expect(selectParams).toEqual([ZONE_CONTEXT_LINK_EVENT_TYPE]);
    const [, insertParams] = pool.query.mock.calls[1];
    const event = JSON.parse(insertParams[2][0]);
    expect(event.data.backfill).toBe(true);
    expect(event.data.vinculadaEn).toBe('2026-11-12T10:00:00.000Z');
    expect(event.eventId).toBe(insertParams[1][0]);
    expect(validate(event)).toBe(true);
  });

  it('sin vínculos pendientes no escribe nada (idempotente)', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(repoCon(ON, pool).enqueueMissingZoneContextLinkEvents())
      .resolves.toEqual({ enqueuedCount: 0, skippedCount: 0 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('EmergencyRepository.unlinkZoneContexts', () => {
  it('al anonimizar borra el vínculo y sus eventos que sigan en el outbox', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [] })) };
    await repoCon(ON, pool).unlinkZoneContexts([EMERGENCY_ID]);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toMatch(/DELETE FROM emergencia_contexto_zona/);
    const [outboxSql, outboxParams] = pool.query.mock.calls[1];
    expect(outboxSql).toMatch(/DELETE FROM outbox_events/);
    expect(outboxParams).toEqual([[EMERGENCY_ID], ZONE_CONTEXT_LINK_EVENT_TYPE]);
  });
});
