const { EmergencyRepository, mapEmergency } = require('../repositories/emergency.repository');
const { NotFoundError, ConflictError } = require('../errors/app-errors');
const { createLocationCrypto } = require('../security/location-crypto');
const { TERMINAL_STATUSES } = require('../domain/emergency-status');

const fakeCrypto = {
  encryptLocation: () => 'encrypted-blob',
  decryptLocation: () => ({ latitude: -34.6, longitude: -58.4 }),
};

function createClient(handler) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/^BEGIN$/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) return { rows: [] };
      return handler(sql, params);
    }),
    release: jest.fn(),
  };
}

function createPool({ query, client } = {}) {
  return {
    query: jest.fn(query || (async () => ({ rows: [] }))),
    connect: jest.fn(async () => client),
  };
}

describe('mapEmergency filas legacy y anonimizadas', () => {
  it('usa lat/lng en claro cuando no hay ciphertext (fila legacy)', () => {
    const mapped = mapEmergency({
      id: 'e-1', latitude: '-34.6', longitude: '-58.4', location_encrypted: null, location_anonymized_at: null,
    }, fakeCrypto);
    expect(mapped.latitude).toBe(-34.6);
    expect(mapped.longitude).toBe(-58.4);
  });

  it('no intenta desencriptar si la ubicación ya fue anonimizada', () => {
    const mapped = mapEmergency({
      id: 'e-2', location_encrypted: 'x', location_anonymized_at: '2024-01-01',
    }, fakeCrypto);
    expect(mapped.latitude).toBeNull();
    expect(mapped.locationAnonymized).toBe(true);
    expect(mapped.locationUnavailable).toBe(false);
  });
});

describe('EmergencyRepository.create', () => {
  it('inserta sin outbox usando pool.query directo', async () => {
    const pool = createPool({
      query: async (sql, params) => {
        expect(sql).toMatch(/INSERT INTO emergencies/);
        expect(params[3]).toBe('encrypted-blob');
        return { rows: [{ id: 'e-1', correlation_id: 'e-1', emergency_type: 'PANICO' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const created = await repo.create({
      id: 'e-1', userId: 'u-1', latitude: -34, longitude: -58, description: 'd', severity: 'high', emergencyType: 'PANICO',
    });

    expect(created.id).toBe('e-1');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('pasa el address a encryptLocation junto con latitude/longitude', async () => {
    const encryptLocation = jest.fn(() => 'encrypted-blob-con-address');
    const crypto = { encryptLocation, decryptLocation: fakeCrypto.decryptLocation };
    const pool = createPool({
      query: async (sql, params) => {
        expect(params[3]).toBe('encrypted-blob-con-address');
        return { rows: [{ id: 'e-1', correlation_id: 'e-1' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: crypto });

    await repo.create({
      id: 'e-1', userId: 'u-1', latitude: -34, longitude: -58, address: 'Av. Corrientes 1234', emergencyType: 'PANICO',
    });

    expect(encryptLocation).toHaveBeenCalledWith({ latitude: -34, longitude: -58, address: 'Av. Corrientes 1234' });
  });

  it('deriva barrio por PIP al crear y lo manda en el INSERT', async () => {
    let insertParams;
    const pool = createPool({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO emergencies')) insertParams = params;
        return { rows: [{ id: 'e-barrio', correlation_id: 'e-barrio', barrio: 'PALERMO' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const created = await repo.create({
      id: 'e-barrio',
      userId: 'u-1',
      latitude: -34.5735,
      longitude: -58.4233,
      emergencyType: 'PANICO',
    });

    expect(insertParams[12]).toBe('PALERMO');
    expect(created.barrio).toBe('PALERMO');
  });

  it('sin coords usa barrioText solo si está en el catálogo', async () => {
    let insertParams;
    const pool = createPool({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO emergencies')) insertParams = params;
        return { rows: [{ id: 'e-txt', correlation_id: 'e-txt', barrio: 'ALMAGRO' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await repo.create({
      id: 'e-txt',
      userId: null,
      latitude: null,
      longitude: null,
      emergencyType: 'PREVENTIVA',
      source: 'EXTERNAL',
      barrioText: 'Almagro',
    });

    expect(insertParams[12]).toBe('ALMAGRO');
  });

  it('sin coords y barrioText fuera de catálogo (Centro) → barrio null', async () => {
    let insertParams;
    const pool = createPool({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO emergencies')) insertParams = params;
        return { rows: [{ id: 'e-centro', correlation_id: 'e-centro', barrio: null }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await repo.create({
      id: 'e-centro',
      userId: null,
      latitude: null,
      longitude: null,
      emergencyType: 'PREVENTIVA',
      source: 'EXTERNAL',
      barrioText: 'Centro',
    });

    expect(insertParams[12]).toBeNull();
  });

  it('coords de San Telmo ganan sobre barrioText discrepante', async () => {
    let insertParams;
    const pool = createPool({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO emergencies')) insertParams = params;
        return { rows: [{ id: 'e-st', correlation_id: 'e-st', barrio: 'SAN TELMO' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await repo.create({
      id: 'e-st',
      userId: 'u-1',
      latitude: -34.6211,
      longitude: -58.3736,
      emergencyType: 'PANICO',
      barrioText: 'Almagro',
    });

    expect(insertParams[12]).toBe('SAN TELMO');
  });

  it('inserta con outbox en una transacción y hace COMMIT', async () => {
    const client = createClient((sql) => {
      if (sql.includes('INSERT INTO emergencies')) {
        return { rows: [{ id: 'e-2', correlation_id: 'e-2' }] };
      }
      if (sql.includes('INSERT INTO outbox_events')) {
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const created = await repo.create({
      id: 'e-2', userId: 'u-1', outboxEvent: { topic: 't', payload: { a: 1 } },
    });

    expect(created.id).toBe('e-2');
    expect(client.calls.map((c) => c.sql.trim().split('\n')[0])).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT'])
    );
    expect(client.release).toHaveBeenCalled();
  });

  it('con client del caller inserta y encola el outbox sin abrir transacción', async () => {
    const client = createClient((sql) => {
      if (sql.includes('INSERT INTO emergencies')) {
        return { rows: [{ id: 'e-3', correlation_id: 'e-3', source: 'EXTERNAL', causa_tipo: 'EVENTO_PUBLICO', causa_id: 'ev-1' }] };
      }
      if (sql.includes('INSERT INTO outbox_events')) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const created = await repo.create({
      client,
      id: 'e-3',
      userId: null,
      latitude: null,
      longitude: null,
      emergencyType: 'PREVENTIVA',
      source: 'EXTERNAL',
      requiresManualValidation: true,
      causaTipo: 'EVENTO_PUBLICO',
      causaId: 'ev-1',
      outboxEvent: { topic: 't', payload: { a: 1 } },
    });

    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.calls.map((c) => c.sql)).not.toContain('BEGIN');
    const insert = client.calls.find((c) => c.sql.includes('INSERT INTO emergencies'));
    // Sin ubicación no se cifra nada; barrio queda null (sin coords ni texto de catálogo).
    expect(insert.params[3]).toBeNull();
    expect(insert.params.slice(8)).toEqual(['EXTERNAL', true, 'EVENTO_PUBLICO', 'ev-1', null]);
    expect(created).toMatchObject({ source: 'EXTERNAL', causaTipo: 'EVENTO_PUBLICO', causaId: 'ev-1' });
    expect(client.release).not.toHaveBeenCalled();
  });

  it('findByCausa busca con FOR UPDATE en el executor que recibe', async () => {
    const client = { query: jest.fn(async () => ({ rows: [{ id: 'e-3', status: 'PENDING', emergency_type: 'PREVENTIVA' }] })) };
    const repo = new EmergencyRepository(createPool(), { locationCrypto: fakeCrypto });

    const rows = await repo.findByCausa(client, { causaTipo: 'EVENTO_PUBLICO', causaId: 'ev-1', emergencyType: 'PREVENTIVA' });

    expect(rows).toEqual([{ id: 'e-3', status: 'PENDING', emergencyType: 'PREVENTIVA' }]);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE/);
    expect(params).toEqual(['EVENTO_PUBLICO', 'ev-1', 'PREVENTIVA']);
  });

  it('hace ROLLBACK y repropaga el error si el INSERT falla', async () => {
    const client = createClient((sql) => {
      if (sql.includes('INSERT INTO emergencies')) throw new Error('db down');
      return { rows: [] };
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await expect(repo.create({
      id: 'e-3', userId: 'u-1', outboxEvent: { topic: 't', payload: {} },
    })).rejects.toThrow('db down');

    expect(client.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('insertOutboxEvent soporta un payload function', async () => {
    const client = createClient((sql) => {
      if (sql.includes('INSERT INTO emergencies')) return { rows: [{ id: 'e-4' }] };
      if (sql.includes('INSERT INTO outbox_events')) return { rows: [] };
      return { rows: [] };
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await repo.create({
      id: 'e-4',
      userId: 'u-1',
      outboxEvent: { topic: 't', payload: (entity, eventId) => ({ entity, eventId }) },
    });

    const outboxCall = client.calls.find((c) => c.sql.includes('INSERT INTO outbox_events'));
    const payload = JSON.parse(outboxCall.params[2]);
    expect(payload.entity.id).toBe('e-4');
    expect(payload.eventId).toBeDefined();
  });
});

describe('EmergencyRepository lecturas', () => {
  it('findById devuelve null si no existe', async () => {
    const pool = createPool({ query: async () => ({ rows: [] }) });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    expect(await repo.findById('missing')).toBeNull();
  });

  it('findAll mapea todas las filas', async () => {
    const pool = createPool({ query: async () => ({ rows: [{ id: 'e-1' }, { id: 'e-2' }] }) });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const all = await repo.findAll();
    expect(all.map((e) => e.id)).toEqual(['e-1', 'e-2']);
  });

  it('findHistoryByEmergencyId mapea el historial', async () => {
    const pool = createPool({
      query: async () => ({ rows: [{ id: 1, emergency_id: 'e-1', previous_status: 'PENDING', new_status: 'VALIDATED' }] }),
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const history = await repo.findHistoryByEmergencyId('e-1');
    expect(history[0].previousStatus).toBe('PENDING');
  });

  it('findDetailById devuelve null si la emergencia no existe', async () => {
    const pool = createPool({ query: async () => ({ rows: [] }) });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    expect(await repo.findDetailById('missing')).toBeNull();
  });

  it('findDetailById agrega statusHistory a la emergencia', async () => {
    let call = 0;
    const pool = createPool({
      query: async () => {
        call += 1;
        if (call === 1) return { rows: [{ id: 'e-1' }] };
        return { rows: [{ id: 1, emergency_id: 'e-1', previous_status: 'PENDING', new_status: 'VALIDATED' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const detail = await repo.findDetailById('e-1');
    expect(detail.id).toBe('e-1');
    expect(detail.statusHistory).toHaveLength(1);
    expect(detail.incident).toBeNull();
    expect(detail.effectivePriority).toBe(detail.severity);
  });

  it('findDetailById sube un nivel la prioridad de despacho si hay un contexto de zona vigente', async () => {
    const vigenteDesde = new Date('2026-11-21T18:00:00Z');
    const vigenteHasta = new Date('2026-11-21T23:00:00Z');
    const calls = [];
    let call = 0;
    const pool = createPool({
      query: async (sql) => {
        calls.push(sql);
        call += 1;
        if (call > 1) return { rows: [] };
        return {
          rows: [{
            id: 'e-3',
            severity: 'medium',
            barrio: 'PALERMO',
            contexto_tipo: 'EVENTO_ESPACIO_PUBLICO',
            contexto_latitud: -34.5711,
            contexto_longitud: -58.4167,
            contexto_radio_metros: 500,
            contexto_origen: 'espacios',
            contexto_referencia_externa: 'ev-1',
            contexto_descripcion: undefined,
            contexto_vigente_desde: vigenteDesde,
            contexto_vigente_hasta: vigenteHasta,
          }],
        };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const detail = await repo.findDetailById('e-3');

    expect(detail.effectivePriority).toBe('medium');
    expect(detail.dispatchPriority).toBe('high');
    expect(detail.priorityContext).toEqual({
      tipo: 'EVENTO_ESPACIO_PUBLICO',
      latitud: -34.5711,
      longitud: -58.4167,
      radioMetros: 500,
      origen: 'espacios',
      referenciaExterna: 'ev-1',
      descripcion: null,
      vigenteDesde,
      vigenteHasta,
    });
    // El contexto sale del vínculo escrito al crear la emergencia y tiene que
    // seguir en curso; sin PREVENTIVA ni terminales. No se mide distancia acá.
    expect(calls[0]).toMatch(/FROM emergencia_contexto_zona ecz/);
    expect(calls[0]).toMatch(/JOIN contexto_zona c ON c\.id = ecz\.contexto_id/);
    expect(calls[0]).toMatch(/ecz\.emergency_id = e\.id/);
    expect(calls[0]).not.toMatch(/barrio/);
    expect(calls[0]).toMatch(/c\.dado_de_baja_en IS NULL/);
    expect(calls[0]).toMatch(/c\.suspendido_en IS NULL/);
    expect(calls[0]).toMatch(/c\.vigente_desde <= now\(\)/);
    expect(calls[0]).toMatch(/c\.vigente_hasta > now\(\)/);
    expect(calls[0]).toMatch(/IS DISTINCT FROM 'PREVENTIVA'/);
    expect(calls[0]).toMatch(/e\.status NOT IN \('CLOSED', 'CANCELLED', 'DISCARDED'\)/);
  });

  it('sin contexto de zona la prioridad de despacho es la efectiva', async () => {
    let call = 0;
    const pool = createPool({
      query: async () => {
        call += 1;
        return call === 1 ? { rows: [{ id: 'e-4', severity: 'high' }] } : { rows: [] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const detail = await repo.findDetailById('e-4');

    expect(detail.dispatchPriority).toBe('high');
    expect(detail.priorityContext).toBeNull();
  });

  it('findDetailById devuelve incident con sus campos y effectivePriority combinada (LEFT JOIN a incidents)', async () => {
    let call = 0;
    const pool = createPool({
      query: async () => {
        call += 1;
        if (call === 1) {
          return {
            rows: [{
              id: 'e-2',
              severity: 'low',
              incident_id: 'inc-1',
              incident_priority: 'critical',
              incident_score: '87.5',
              incident_report_count: '3',
              incident_unique_citizens: '2',
              incident_reason_codes: ['MULTI_REPORT_THRESHOLD'],
            }],
          };
        }
        return { rows: [] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const detail = await repo.findDetailById('e-2');

    expect(detail.incident).toEqual({
      id: 'inc-1',
      priority: 'critical',
      score: 87.5,
      reportCount: 3,
      uniqueCitizens: 2,
      reasonCodes: ['MULTI_REPORT_THRESHOLD'],
    });
    // severity individual es 'low' pero el incidente es 'critical': la
    // efectiva nunca puede ser menor a la del incidente (src/domain/severity.js).
    expect(detail.effectivePriority).toBe('critical');
  });

  it('recordAccess inserta y mapea la auditoría', async () => {
    const pool = createPool({
      query: async (sql, params) => {
        expect(params).toEqual(['e-1', 'sub-1', 'view']);
        return { rows: [{ id: 1, emergency_id: 'e-1', actor_sub: 'sub-1', action: 'view' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const audit = await repo.recordAccess({ emergencyId: 'e-1', actorSub: 'sub-1', action: 'view' });
    expect(audit.actorSub).toBe('sub-1');
  });

  it('findAccessAuditByEmergencyId mapea filas', async () => {
    const pool = createPool({ query: async () => ({ rows: [{ id: 1, emergency_id: 'e-1', actor_sub: 's', action: 'view' }] }) });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const audits = await repo.findAccessAuditByEmergencyId('e-1');
    expect(audits).toHaveLength(1);
  });
});

describe('EmergencyRepository.backfillBarrios', () => {
  it('actualiza barrio desde ciphertext descifrable y omite indescifrables', async () => {
    const decryptLocation = jest.fn((blob) => {
      if (blob === 'bad') throw new Error('cannot decrypt');
      return { latitude: -34.5735, longitude: -58.4233 };
    });
    const queries = [];
    const pool = createPool({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT id, latitude, longitude, location_encrypted')) {
          return {
            rows: [
              { id: 'e-ok', latitude: null, longitude: null, location_encrypted: 'ok' },
              { id: 'e-bad', latitude: null, longitude: null, location_encrypted: 'bad' },
            ],
          };
        }
        if (sql.includes('SET barrio =')) {
          return { rowCount: 1, rows: [{ id: params[0] }] };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: { ...fakeCrypto, decryptLocation } });

    const result = await repo.backfillBarrios();

    expect(result).toEqual({ updatedCount: 1, ids: ['e-ok'] });
    const update = queries.find((q) => q.sql.includes('SET barrio ='));
    expect(update.params).toEqual(['e-ok', 'PALERMO']);
  });

  it('sin candidatos devolvé cero', async () => {
    const pool = createPool({
      query: async () => ({ rows: [] }),
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.backfillBarrios()).resolves.toEqual({ updatedCount: 0, ids: [] });
  });
});

describe('EmergencyRepository.linkZoneContexts', () => {
  // Rosedal y un punto a ~330 m; el Obelisco queda a más de 4 km.
  const ROSEDAL = { latitud: -34.5711, longitud: -58.4167 };
  const CERCA = { latitude: -34.5740, longitude: -58.4160 };
  const LEJOS = { latitude: -34.6037, longitude: -58.3816 };

  function executorCon(contextos) {
    return { query: jest.fn().mockResolvedValueOnce({ rows: contextos }).mockResolvedValue({ rows: [] }) };
  }

  it('vincula solo los contextos en curso que alcanzan a la emergencia y guarda nada más que ids', async () => {
    const repo = new EmergencyRepository(createPool(), { locationCrypto: fakeCrypto });
    const executor = executorCon([
      { id: 'ctx-cerca', ...ROSEDAL, radio_metros: 500 },
      { id: 'ctx-radio-chico', ...ROSEDAL, radio_metros: 100 },
      { id: 'ctx-lejos', latitud: LEJOS.latitude, longitud: LEJOS.longitude, radio_metros: 500 },
    ]);

    const ids = await repo.linkZoneContexts(executor, { id: 'e-1', ...CERCA, emergencyType: 'MEDICA' });

    expect(ids).toEqual(['ctx-cerca']);
    const [selectSql] = executor.query.mock.calls[0];
    expect(selectSql).toMatch(/c\.dado_de_baja_en IS NULL/);
    expect(selectSql).toMatch(/c\.suspendido_en IS NULL/);
    expect(selectSql).toMatch(/c\.vigente_desde <= now\(\)/);
    expect(selectSql).toMatch(/c\.vigente_hasta > now\(\)/);
    // La coordenada de la emergencia no viaja a la base: se compara en memoria.
    expect(executor.query.mock.calls[0][1]).toBeUndefined();
    const [insertSql, insertValues] = executor.query.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO emergencia_contexto_zona \(emergency_id, contexto_id\)/);
    expect(insertValues).toEqual(['e-1', ['ctx-cerca']]);
  });

  it('sin contextos que la alcancen no escribe nada', async () => {
    const repo = new EmergencyRepository(createPool(), { locationCrypto: fakeCrypto });
    const executor = executorCon([{ id: 'ctx-1', ...ROSEDAL, radio_metros: 500 }]);

    await expect(repo.linkZoneContexts(executor, { id: 'e-2', ...LEJOS, emergencyType: 'MEDICA' })).resolves.toEqual([]);
    expect(executor.query).toHaveBeenCalledTimes(1);
  });

  it('no consulta nada para una emergencia sin ubicación ni para una PREVENTIVA', async () => {
    const repo = new EmergencyRepository(createPool(), { locationCrypto: fakeCrypto });
    const executor = executorCon([{ id: 'ctx-1', ...ROSEDAL, radio_metros: 500 }]);

    await expect(repo.linkZoneContexts(executor, { id: 'e-3', latitude: null, longitude: null })).resolves.toEqual([]);
    await expect(repo.linkZoneContexts(executor, { id: 'e-4', ...CERCA, emergencyType: 'PREVENTIVA' })).resolves.toEqual([]);
    expect(executor.query).not.toHaveBeenCalled();
  });
});

describe('EmergencyRepository.anonymizeExpiredLocations', () => {
  it('rechaza retentionHours no positivo', async () => {
    const pool = createPool();
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.anonymizeExpiredLocations(0)).rejects.toThrow('retentionHours must be a positive number');
    await expect(repo.anonymizeExpiredLocations('nope')).rejects.toThrow('retentionHours must be a positive number');
  });

  it('anonimiza, deriva barrio si faltaba y scrubea coords del outbox', async () => {
    const queries = [];
    const pool = createPool({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT id, latitude, longitude, location_encrypted, barrio')) {
          return {
            rows: [
              { id: 'e-1', latitude: null, longitude: null, location_encrypted: 'blob', barrio: 'PALERMO' },
              { id: 'e-2', latitude: null, longitude: null, location_encrypted: 'blob', barrio: null },
            ],
          };
        }
        if (sql.includes('UPDATE outbox_events')) {
          return { rowCount: 2, rows: [] };
        }
        return { rowCount: 1, rows: [{ id: params[0] }] };
      },
    });
    const decryptLocation = jest.fn(() => ({ latitude: -34.5735, longitude: -58.4233 }));
    const repo = new EmergencyRepository(pool, {
      locationCrypto: { ...fakeCrypto, decryptLocation },
    });
    const result = await repo.anonymizeExpiredLocations(72);
    expect(result).toEqual({ anonymizedCount: 2, ids: ['e-1', 'e-2'] });
    expect(queries[0].sql).toMatch(/closed_at IS NOT NULL/);
    expect(queries[0].sql).toMatch(/closed_at < now\(\)/);
    expect(queries[0].sql).not.toMatch(/created_at </);
    expect(queries[0].params).toEqual([72]);
    // e-1 ya tenía barrio; e-2 lo deriva antes de borrar la ubicación.
    expect(queries[1].params).toEqual(['e-1', 'PALERMO']);
    expect(queries[2].params).toEqual(['e-2', 'PALERMO']);
    expect(queries[1].sql).toMatch(/COALESCE\(barrio/);
    const scrub = queries.find((q) => q.sql.includes('UPDATE outbox_events'));
    expect(scrub.params[0]).toEqual(['e-1', 'e-2']);
  });

  it('sin candidatos devolvé cero', async () => {
    const pool = createPool({
      query: async () => ({ rows: [] }),
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.anonymizeExpiredLocations(72)).resolves.toEqual({ anonymizedCount: 0, ids: [] });
  });
});

describe('EmergencyRepository.anonymizeUndecryptableLocations', () => {
  it('devuelve vacío si no hay candidatos indescifrables', async () => {
    const crypto = { decryptLocation: () => ({ latitude: 1, longitude: 1 }) };
    const pool = createPool({ query: async () => ({ rows: [{ id: 'e-1', location_encrypted: 'ok' }] }) });
    const repo = new EmergencyRepository(pool, { locationCrypto: crypto });
    const result = await repo.anonymizeUndecryptableLocations();
    expect(result).toEqual({ anonymizedCount: 0, ids: [] });
  });

  it('anonimiza únicamente las filas que no se pueden descifrar', async () => {
    const crypto = {
      decryptLocation: (value) => {
        if (value === 'bad') throw new Error('cannot decrypt');
        return { latitude: 1, longitude: 1 };
      },
    };
    let call = 0;
    const pool = createPool({
      query: async () => {
        call += 1;
        if (call === 1) {
          return { rows: [{ id: 'e-1', location_encrypted: 'ok' }, { id: 'e-2', location_encrypted: 'bad' }] };
        }
        return { rowCount: 1, rows: [{ id: 'e-2' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: crypto });
    const result = await repo.anonymizeUndecryptableLocations();
    expect(result).toEqual({ anonymizedCount: 1, ids: ['e-2'] });
  });
});

describe('EmergencyRepository.findPage', () => {
  const baseArgs = {
    userId: null, statuses: [], severity: null, from: null, to: null,
    assignedOfficerId: null, emergencyType: null, page: 1, limit: 20, sortBy: 'createdAt', order: 'desc',
  };

  it('arma el WHERE con todos los filtros posibles', async () => {
    const calls = [];
    const pool = createPool({
      query: async (sql, params) => {
        calls.push({ sql, params });
        // "AS total" es único de la query de COUNT: la SELECT principal
        // también tiene subqueries con COUNT(*) (para incident_report_count/
        // incident_unique_citizens), así que `includes('COUNT(*)')` a solas
        // matchearía las dos.
        if (sql.includes('AS total')) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 'e-1' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.findPage({
      ...baseArgs,
      userId: 'u-1',
      statuses: ['PENDING', 'VALIDATED'],
      severity: 'high',
      from: '2024-01-01',
      to: '2024-02-01',
      assignedOfficerId: 'o-1',
      emergencyType: 'PANICO',
      sortBy: 'priority',
      order: 'asc',
    });

    expect(result.total).toBe(1);
    expect(result.emergencies).toHaveLength(1);
    const selectCall = calls[1];
    expect(selectCall.sql).toMatch(/WHERE/);
    expect(selectCall.sql).toMatch(/ASC/);
    expect(selectCall.sql).toMatch(/CASE e.severity/);
    expect(selectCall.sql).toMatch(/CASE i.priority/);
    expect(selectCall.sql).toMatch(/GREATEST\(/);
    // Prioridad de despacho: +1 con contexto de zona vigente, tope 4.
    expect(selectCall.sql).toMatch(/LEAST\(GREATEST\(.*\) \+ CASE WHEN cz\.tipo IS NULL THEN 0 ELSE 1 END, 4\)/);
    expect(selectCall.sql).toMatch(/LEFT JOIN incidents i ON i.id = e.incident_id/);
    // sin incidente: incident null y effectivePriority = la propia severity
    expect(result.emergencies[0].incident).toBeNull();
    expect(result.emergencies[0].effectivePriority).toBe(result.emergencies[0].severity);
  });

  it('sortBy=priority ordena por LEAST(severity, incident.priority) y devuelve el incident embebido', async () => {
    const pool = createPool({
      query: async (sql) => (sql.includes('AS total')
        ? { rows: [{ total: 1 }] }
        : {
          rows: [{
            id: 'e-9',
            severity: 'low',
            incident_id: 'inc-9',
            incident_priority: 'high',
            incident_score: 55,
            incident_report_count: 4,
            incident_unique_citizens: 3,
            incident_reason_codes: ['PROXIMITY_CLUSTER'],
          }],
        }),
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const { emergencies } = await repo.findPage({ ...baseArgs, sortBy: 'priority' });

    expect(emergencies[0].incident).toEqual({
      id: 'inc-9', priority: 'high', score: 55, reportCount: 4, uniqueCitizens: 3, reasonCodes: ['PROXIMITY_CLUSTER'],
    });
    expect(emergencies[0].effectivePriority).toBe('high');
  });

  it('sin filtros no agrega WHERE y usa DESC por defecto', async () => {
    const calls = [];
    const pool = createPool({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await repo.findPage(baseArgs);

    expect(calls[0].sql).not.toMatch(/WHERE/);
    expect(calls[1].sql).toMatch(/DESC/);
  });
});

describe('EmergencyRepository.findOutboxPage', () => {
  it('filtra por status y topic cuando vienen', async () => {
    const calls = [];
    const pool = createPool({
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 'ev-1', topic: 't', status: 'PENDING', attempts: 0 }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.findOutboxPage({ status: 'PENDING', topic: 't', page: 2, limit: 10 });

    expect(result.total).toBe(1);
    expect(result.events[0].id).toBe('ev-1');
    expect(calls[0].sql).toMatch(/WHERE status = \$1 AND topic = \$2/);
  });

  it('sin filtros usa defaults de página', async () => {
    const pool = createPool({
      query: async (sql) => (sql.includes('COUNT(*)') ? { rows: [{ total: 0 }] } : { rows: [] }),
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const result = await repo.findOutboxPage({});
    expect(result.total).toBe(0);
    expect(result.events).toEqual([]);
  });
});

describe('EmergencyRepository.updateStatus', () => {
  it('lanza NotFoundError y hace ROLLBACK si la emergencia no existe', async () => {
    const client = createClient((sql) => {
      if (sql.includes('FOR UPDATE')) return { rows: [] };
      return { rows: [] };
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await expect(repo.updateStatus('missing', { newStatus: 'VALIDATED' })).rejects.toThrow(NotFoundError);
    expect(client.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('actualiza estado, guarda historial y libera al oficial en CANCELLED', async () => {
    const client = createClient((sql) => {
      if (sql.includes('SELECT status, assigned_officer_id')) {
        return { rows: [{ status: 'VALIDATED', assigned_officer_id: 'o-1' }] };
      }
      if (sql.startsWith('UPDATE emergencies')) {
        return { rows: [{ id: 'e-1', status: 'CANCELLED' }] };
      }
      if (sql.includes('INSERT INTO emergency_status_history')) {
        return { rows: [{ id: 1, previous_status: 'VALIDATED', new_status: 'CANCELLED' }] };
      }
      if (sql.includes("UPDATE officers SET status = 'disponible'")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.updateStatus('e-1', { newStatus: 'CANCELLED', actor: 'dispatcher-1', reason: 'x' });

    expect(result.emergency.status).toBe('CANCELLED');
    expect(client.calls.some((c) => c.sql.includes("UPDATE officers SET status = 'disponible'"))).toBe(true);
    expect(client.calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it('con client del caller transiciona sin abrir ni cerrar transacción', async () => {
    const client = createClient((sql) => {
      if (sql.includes('SELECT status, assigned_officer_id')) {
        return { rows: [{ status: 'PENDING', assigned_officer_id: null }] };
      }
      if (sql.startsWith('UPDATE emergencies')) return { rows: [{ id: 'e-1', status: 'CANCELLED' }] };
      if (sql.includes('INSERT INTO emergency_status_history')) {
        return { rows: [{ id: 1, previous_status: 'PENDING', new_status: 'CANCELLED' }] };
      }
      return { rows: [] };
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.updateStatus('e-1', {
      client,
      newStatus: 'CANCELLED',
      actor: 'eda:espacios',
      outboxEvent: { topic: 't', payload: { a: 1 } },
    });

    expect(result.history.newStatus).toBe('CANCELLED');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.calls.map((c) => c.sql)).toEqual(expect.not.arrayContaining(['BEGIN', 'COMMIT', 'ROLLBACK']));
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO outbox_events'))).toBe(true);
    expect(client.release).not.toHaveBeenCalled();
  });

  it('no libera oficial si no hay uno asignado y guarda outbox si se pasa', async () => {
    const client = createClient((sql) => {
      if (sql.includes('SELECT status, assigned_officer_id')) {
        return { rows: [{ status: 'PENDING', assigned_officer_id: null }] };
      }
      if (sql.startsWith('UPDATE emergencies')) {
        return { rows: [{ id: 'e-1', status: 'VALIDATED' }] };
      }
      if (sql.includes('INSERT INTO emergency_status_history')) {
        return { rows: [{ id: 1, previous_status: 'PENDING', new_status: 'VALIDATED' }] };
      }
      if (sql.includes('INSERT INTO outbox_events')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await repo.updateStatus('e-1', {
      newStatus: 'VALIDATED', outboxEvent: { topic: 't', payload: {} },
    });

    expect(client.calls.some((c) => c.sql.includes('officers'))).toBe(false);
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO outbox_events'))).toBe(true);
  });

  it('propaga y hace ROLLBACK si la transición es inválida', async () => {
    const client = createClient((sql) => {
      if (sql.includes('SELECT status, assigned_officer_id')) {
        return { rows: [{ status: 'CLOSED', assigned_officer_id: null }] };
      }
      return { rows: [] };
    });
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await expect(repo.updateStatus('e-1', { newStatus: 'VALIDATED' })).rejects.toThrow(ConflictError);
    expect(client.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });
});

describe('EmergencyRepository.updateStatus: estado de origen, closed_at y oficial asignado', () => {
  function clientWithCurrent(current) {
    return createClient((sql, params) => {
      if (sql.includes('SELECT status, assigned_officer_id')) return { rows: [current] };
      if (sql.startsWith('UPDATE emergencies')) return { rows: [{ id: 'e-1', status: params[0] }] };
      if (sql.includes('INSERT INTO emergency_status_history')) {
        return { rows: [{ id: 1, previous_status: current.status, new_status: params[2] }] };
      }
      return { rows: [] };
    });
  }

  it('con requireStatus distinto del estado bajo lock responde ConflictError sin tocar la fila', async () => {
    const client = clientWithCurrent({ status: 'DISPATCHED', assigned_officer_id: 'o-1' });
    const repo = new EmergencyRepository(createPool({ client }), { locationCrypto: fakeCrypto });

    await expect(repo.updateStatus('e-1', { newStatus: 'VALIDATED', requireStatus: 'PENDING' }))
      .rejects.toThrow(new ConflictError('Emergency e-1 is DISPATCHED, expected PENDING'));

    expect(client.calls.some((c) => c.sql.startsWith('UPDATE emergencies'))).toBe(false);
    expect(client.calls.some((c) => c.sql.includes('officers'))).toBe(false);
    expect(client.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('con requireStatus igual al estado bajo lock aplica la transición', async () => {
    const client = clientWithCurrent({ status: 'DISPATCHED', assigned_officer_id: 'o-1' });
    const repo = new EmergencyRepository(createPool({ client }), { locationCrypto: fakeCrypto });

    const result = await repo.updateStatus('e-1', { newStatus: 'VALIDATED', requireStatus: 'DISPATCHED' });

    expect(result.emergency.status).toBe('VALIDATED');
    expect(client.calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it.each([
    ['CLOSED', 'RESOLVED'],
    ['CANCELLED', 'VALIDATED'],
    ['DISCARDED', 'PENDING'],
  ])('setea closed_at al pasar a %s (terminal)', async (newStatus, from) => {
    const client = clientWithCurrent({ status: from, assigned_officer_id: null });
    const repo = new EmergencyRepository(createPool({ client }), { locationCrypto: fakeCrypto });

    await repo.updateStatus('e-1', { newStatus });

    const update = client.calls.find((c) => c.sql.startsWith('UPDATE emergencies'));
    expect(update.sql).toMatch(/closed_at = CASE WHEN \$3::boolean THEN now\(\) ELSE closed_at END/);
    expect(update.params).toEqual([newStatus, 'e-1', true, [], null]);
  });

  it.each([
    ['VALIDATED', 'PENDING'],
    ['EN_ROUTE', 'DISPATCHED'],
    ['RESOLVED', 'ON_SCENE'],
  ])('no toca closed_at al pasar a %s (no terminal)', async (newStatus, from) => {
    const client = clientWithCurrent({ status: from, assigned_officer_id: null });
    const repo = new EmergencyRepository(createPool({ client }), { locationCrypto: fakeCrypto });

    await repo.updateStatus('e-1', { newStatus });

    const update = client.calls.find((c) => c.sql.startsWith('UPDATE emergencies'));
    expect(update.params).toEqual([newStatus, 'e-1', false, [], null]);
  });

  it('al pasar a VALIDATED limpia assigned_officer_id y libera al oficial en la misma transacción', async () => {
    const client = clientWithCurrent({ status: 'DISPATCHED', assigned_officer_id: 'o-1' });
    const repo = new EmergencyRepository(createPool({ client }), { locationCrypto: fakeCrypto });

    await repo.updateStatus('e-1', { newStatus: 'VALIDATED', requireStatus: 'DISPATCHED' });

    const update = client.calls.find((c) => c.sql.startsWith('UPDATE emergencies'));
    expect(update.sql).toMatch(/assigned_officer_id = CASE WHEN \$1 = 'VALIDATED' THEN NULL ELSE assigned_officer_id END/);
    const release = client.calls.find((c) => c.sql.includes("UPDATE officers SET status = 'disponible'"));
    expect(release.params).toEqual(['o-1']);
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.indexOf(release.sql)).toBeLessThan(sqls.indexOf('COMMIT'));
  });
});

describe('EmergencyRepository.setIncidentId', () => {
  it('lanza NotFoundError si no actualiza ninguna fila', async () => {
    const pool = createPool({ query: async () => ({ rows: [] }) });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.setIncidentId('missing', 'i-1')).rejects.toThrow(NotFoundError);
  });

  it('devuelve la emergencia mapeada si actualiza', async () => {
    const pool = createPool({ query: async () => ({ rows: [{ id: 'e-1', incident_id: 'i-1' }] }) });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const emergency = await repo.setIncidentId('e-1', 'i-1');
    expect(emergency.incidentId).toBe('i-1');
  });
});

describe('EmergencyRepository.assignOfficer', () => {
  function baseHandler({ emergencyRows = [{ id: 'e-1', status: 'VALIDATED', assigned_officer_id: null }], officerRows = [{ id: 'o-1', status: 'disponible', name: 'Ana' }] } = {}) {
    return (sql) => {
      if (sql.includes('FROM emergencies WHERE id = $1 FOR UPDATE')) return { rows: emergencyRows };
      if (sql.includes('FROM officers WHERE id = $1 FOR UPDATE')) return { rows: officerRows };
      if (sql.startsWith('UPDATE emergencies e')) return { rows: [{ id: 'e-1', status: 'DISPATCHED' }] };
      if (sql.includes('INSERT INTO emergency_status_history')) return { rows: [{ id: 1, previous_status: 'VALIDATED', new_status: 'DISPATCHED' }] };
      return { rows: [] };
    };
  }

  it('lanza NotFoundError si la emergencia no existe', async () => {
    const client = createClient(baseHandler({ emergencyRows: [] }));
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.assignOfficer('missing', { officerId: 'o-1' })).rejects.toThrow(NotFoundError);
    expect(client.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('lanza NotFoundError si el oficial no existe', async () => {
    const client = createClient(baseHandler({ officerRows: [] }));
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.assignOfficer('e-1', { officerId: 'missing' })).rejects.toThrow(NotFoundError);
  });

  it('lanza ConflictError si el oficial no está disponible', async () => {
    const client = createClient(baseHandler({ officerRows: [{ id: 'o-1', status: 'ocupado', name: 'Ana' }] }));
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.assignOfficer('e-1', { officerId: 'o-1' })).rejects.toThrow(ConflictError);
  });

  it('libera al oficial anterior si había uno distinto asignado', async () => {
    const client = createClient(baseHandler({
      emergencyRows: [{ id: 'e-1', status: 'VALIDATED', assigned_officer_id: 'o-old' }],
    }));
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await repo.assignOfficer('e-1', { officerId: 'o-1', actor: 'dispatcher-1' });

    expect(client.calls.some((c) => c.sql.includes("UPDATE officers SET status = 'disponible'") && c.params[0] === 'o-old')).toBe(true);
  });

  it('asigna oficial nuevo, guarda historial y outbox, y hace COMMIT', async () => {
    const client = createClient(baseHandler());
    const pool = createPool({ client });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.assignOfficer('e-1', {
      officerId: 'o-1', actor: 'dispatcher-1', outboxEvent: { topic: 't', payload: {} },
    });

    expect(result.officer.status).toBe('ocupado');
    expect(result.emergency.assignedOfficer).toBe('Ana');
    expect(client.calls.some((c) => c.sql.includes('INSERT INTO outbox_events'))).toBe(true);
    expect(client.calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });
});

// Round-trip con el cifrado real (no un stub): cubre que create() persiste
// address dentro de location_encrypted y que mapEmergency la recupera igual
// que lat/lng, sin columna nueva.
describe('EmergencyRepository dirección legible persistida junto con la ubicación cifrada', () => {
  const realCrypto = createLocationCrypto(Buffer.alloc(32, 5).toString('base64'));

  function poolEchoingInsert() {
    return createPool({
      // Simula el INSERT ... RETURNING *: devuelve la fila con el
      // location_encrypted real que armó encryptLocation.
      query: async (sql, params = []) => ({ rows: [{ id: params[0], location_encrypted: params[3] }] }),
    });
  }

  it('guarda y recupera la dirección junto a lat/lng cifrados', async () => {
    const repo = new EmergencyRepository(poolEchoingInsert(), { locationCrypto: realCrypto });

    const created = await repo.create({
      id: 'e-addr-1',
      userId: 'u-1',
      latitude: -34.6037,
      longitude: -58.3816,
      address: 'Av. Corrientes 1234, CABA',
      emergencyType: 'PANICO',
    });

    expect(created.address).toBe('Av. Corrientes 1234, CABA');
    expect(created.latitude).toBeCloseTo(-34.6037);
    expect(created.longitude).toBeCloseTo(-58.3816);
  });

  it('sin address, se persiste y se lee como null', async () => {
    const repo = new EmergencyRepository(poolEchoingInsert(), { locationCrypto: realCrypto });

    const created = await repo.create({
      id: 'e-addr-2', userId: 'u-1', latitude: -34.6037, longitude: -58.3816, emergencyType: 'PANICO',
    });

    expect(created.address).toBeNull();
  });

  it('trunca a 200 caracteres una dirección más larga (comportamiento delegado, no revalidado acá)', () => {
    // La validación/truncado de longitud vive en el controller (input del
    // usuario); acá solo se confirma que el crypto no trunca por su cuenta:
    // si al repository ya le llega truncada, la persiste y lee tal cual.
    const truncated = 'A'.repeat(200);
    const ciphertext = realCrypto.encryptLocation({ latitude: -1, longitude: -1, address: truncated });
    const mapped = mapEmergency({ id: 'e-addr-3', location_encrypted: ciphertext, location_anonymized_at: null }, realCrypto);
    expect(mapped.address).toHaveLength(200);
    expect(mapped.address).toBe(truncated);
  });

  it('fila anonimizada no expone la dirección aunque el ciphertext la tenga', () => {
    const ciphertext = realCrypto.encryptLocation({
      latitude: -34.6, longitude: -58.4, address: 'Calle Falsa 123',
    });

    const mapped = mapEmergency(
      { id: 'e-addr-4', location_encrypted: ciphertext, location_anonymized_at: '2024-01-01' },
      realCrypto
    );

    expect(mapped.locationAnonymized).toBe(true);
    expect(mapped.address).toBeNull();
    expect(mapped.latitude).toBeNull();
  });

  it('fila indescifrable (otra clave) devuelve address null igual que lat/lng', () => {
    const otherKeyCrypto = createLocationCrypto(Buffer.alloc(32, 9).toString('base64'));
    const ciphertext = otherKeyCrypto.encryptLocation({
      latitude: -34.6, longitude: -58.4, address: 'Calle Falsa 123',
    });

    const mapped = mapEmergency(
      { id: 'e-addr-5', location_encrypted: ciphertext, location_anonymized_at: null },
      realCrypto
    );

    expect(mapped.locationUnavailable).toBe(true);
    expect(mapped.address).toBeNull();
  });
});

describe('EmergencyRepository.findRecentByType (candidatos para el job de detección de incidentes, #60)', () => {
  const crypto = createLocationCrypto(Buffer.alloc(32, 3).toString('base64'));

  it('incluye una fila legacy sin ciphertext (location_encrypted null) con lat/lng null', async () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const pool = createPool({
      query: async (sql, params) => {
        expect(sql).toMatch(/FROM emergencies/);
        expect(params).toEqual([['INCENDIO'], since, ['CLOSED', 'CANCELLED', 'DISCARDED']]);
        return {
          rows: [{
            id: 'e1',
            correlation_id: 'c1',
            user_id: 'u1',
            emergency_type: 'INCENDIO',
            latitude: null,
            longitude: null,
            location_encrypted: null,
            severity: 'low',
            incident_id: null,
            created_at: 'c',
          }],
        };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: crypto });

    const candidates = await repo.findRecentByType({ emergencyType: 'INCENDIO', since });

    expect(candidates).toEqual([{
      id: 'e1',
      correlationId: 'c1',
      userId: 'u1',
      emergencyType: 'INCENDIO',
      latitude: null,
      longitude: null,
      severity: 'low',
      incidentId: null,
      createdAt: 'c',
    }]);
  });

  it('con emergencyTypes pide varios tipos en una sola query y excluye los estados terminales', async () => {
    const since = new Date('2026-01-01T00:00:00.000Z');
    const query = jest.fn(async () => ({
      rows: [
        {
          id: 'e5', correlation_id: 'c5', user_id: 'u5', emergency_type: 'PANICO', location_encrypted: null, severity: 'high', incident_id: null, created_at: 'c',
        },
        {
          id: 'e6', correlation_id: 'c6', user_id: 'u6', emergency_type: 'MEDICA', location_encrypted: null, severity: 'medium', incident_id: null, created_at: 'c',
        },
      ],
    }));
    const repo = new EmergencyRepository(createPool({ query }), { locationCrypto: crypto });

    const candidates = await repo.findRecentByType({ emergencyTypes: ['PANICO', 'MEDICA'], since });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/emergency_type = ANY\(\$1::text\[\]\)/);
    expect(sql).toMatch(/status <> ALL\(\$3::text\[\]\)/);
    expect(params).toEqual([['PANICO', 'MEDICA'], since, TERMINAL_STATUSES]);
    expect(candidates.map((c) => [c.id, c.emergencyType])).toEqual([['e5', 'PANICO'], ['e6', 'MEDICA']]);
  });

  it('descifra la ubicación cuando hay ciphertext válido', async () => {
    const ciphertext = crypto.encryptLocation({ latitude: -34.6, longitude: -58.4 });
    const pool = createPool({
      query: async () => ({
        rows: [{
          id: 'e2',
          correlation_id: 'c2',
          user_id: 'u2',
          location_encrypted: ciphertext,
          severity: 'high',
          incident_id: 'inc-1',
          created_at: 'c',
        }],
      }),
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: crypto });

    const candidates = await repo.findRecentByType({ emergencyType: 'INCENDIO', since: new Date() });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'e2', latitude: -34.6, longitude: -58.4, incidentId: 'inc-1',
    });
  });

  it('excluye del resultado una fila con ciphertext indescifrable (otra clave) en vez de romper el listado', async () => {
    const otherKeyCrypto = createLocationCrypto(Buffer.alloc(32, 7).toString('base64'));
    const ciphertext = otherKeyCrypto.encryptLocation({ latitude: -34.6, longitude: -58.4 });
    const pool = createPool({
      query: async () => ({
        rows: [
          {
            id: 'e3', correlation_id: 'c3', user_id: 'u3', location_encrypted: ciphertext, severity: 'low', incident_id: null, created_at: 'c',
          },
          {
            id: 'e4', correlation_id: 'c4', user_id: 'u4', location_encrypted: null, severity: 'low', incident_id: null, created_at: 'c',
          },
        ],
      }),
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: crypto });

    const candidates = await repo.findRecentByType({ emergencyType: 'INCENDIO', since: new Date() });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('e4');
  });
});

describe('EmergencyRepository.expireStaleEmergencies', () => {
  const ROW = {
    id: 'e-1', status: 'PENDING', latitude: null, longitude: null, location_encrypted: 'blob',
    barrio: null, location_anonymized_at: null,
  };

  // Simula lo que ve cada transacción: la fila tomada con SKIP LOCKED y, a
  // partir de ahí, las queries de anonimizar y de applyStatusUpdate.
  function txClient(row, { assignedOfficerId = null, failOn = null } = {}) {
    return createClient(async (sql, params) => {
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      if (sql.includes('FOR UPDATE OF e SKIP LOCKED')) return { rows: row ? [row] : [] };
      if (sql.includes('SET location_encrypted = NULL')) return { rowCount: 1, rows: [{ id: params[0] }] };
      if (sql.startsWith('SELECT status, assigned_officer_id')) {
        return { rows: [{ status: row.status, assigned_officer_id: assignedOfficerId }] };
      }
      if (sql.includes('UPDATE emergencies') && sql.includes('SET status = $1')) {
        return { rows: [{ id: row.id, status: params[0], barrio: 'PALERMO', location_anonymized_at: '2026-11-12' }] };
      }
      if (sql.includes('INSERT INTO emergency_status_history')) {
        return { rows: [{ id: 1, emergency_id: params[0], previous_status: params[1], new_status: params[2], actor: params[3], reason: params[4] }] };
      }
      return { rowCount: 1, rows: [] };
    });
  }

  function poolFor(candidateIds, clients) {
    const queue = [...clients];
    const queries = [];
    const pool = {
      queries,
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('FROM emergencies e') && sql.includes('LIMIT $3')) {
          return { rows: candidateIds.map((id) => ({ id })) };
        }
        return { rowCount: 1, rows: [] };
      }),
      connect: jest.fn(async () => queue.shift()),
    };
    return pool;
  }

  it('rechaza un plazo no positivo', async () => {
    const repo = new EmergencyRepository(createPool(), { locationCrypto: fakeCrypto });
    await expect(repo.expireStaleEmergencies(0)).rejects.toThrow('hours must be a positive number');
    await expect(repo.expireStaleEmergencies('nope')).rejects.toThrow('hours must be a positive number');
  });

  it('sin candidatas no abre transacciones', async () => {
    const pool = poolFor([], []);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await expect(repo.expireStaleEmergencies(72)).resolves.toEqual({ expiredCount: 0, failedCount: 0, expired: [] });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('busca solo emergencias abiertas, por último cambio de estado y con tope', async () => {
    const pool = poolFor([], []);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await repo.expireStaleEmergencies(48, { limit: 10 });

    const { sql, params } = pool.queries[0];
    expect(sql).toMatch(/emergency_status_history/);
    expect(sql).toMatch(/GREATEST\(/);
    expect(sql).not.toMatch(/updated_at/);
    expect(params[0]).toBe(48);
    expect(params[1]).toEqual(['PENDING', 'VALIDATED', 'DISPATCHED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED']);
    expect(params[2]).toBe(10);
  });

  it('anonimiza y cancela una PENDING en una transacción, con historial y evento, y limpia el outbox', async () => {
    const client = txClient(ROW);
    const pool = poolFor(['e-1'], [client]);
    const decryptLocation = jest.fn(() => ({ latitude: -34.5735, longitude: -58.4233 }));
    const repo = new EmergencyRepository(pool, { locationCrypto: { ...fakeCrypto, decryptLocation } });
    const payload = jest.fn(() => ({ type: 'EmergenciaActualizada' }));

    const result = await repo.expireStaleEmergencies(72, {
      actor: 'sistema:expiracion', reason: 'Expirada', outboxEvent: { topic: 't', payload },
    });

    expect(result).toEqual({
      expiredCount: 1, failedCount: 0, expired: [{ id: 'e-1', previousStatus: 'PENDING', newStatus: 'CANCELLED' }],
    });
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    const order = (fragment) => sqls.findIndex((sql) => sql.includes(fragment));
    // Primero se borra la ubicación y después cambia el estado: el evento sale sin coordenadas.
    expect(order('SET location_encrypted = NULL')).toBeLessThan(order('SET status = $1'));
    expect(client.calls[order('SET location_encrypted = NULL')].params).toEqual(['e-1', 'PALERMO']);
    const update = client.calls[order('SET status = $1')];
    expect(update.params[0]).toBe('CANCELLED');
    expect(update.params[2]).toBe(true);
    const history = client.calls[order('INSERT INTO emergency_status_history')];
    expect(history.params).toEqual(['e-1', 'PENDING', 'CANCELLED', 'sistema:expiracion', 'Expirada']);
    expect(payload).toHaveBeenCalledTimes(1);
    expect(payload.mock.calls[0][0].emergency).toMatchObject({ status: 'CANCELLED', latitude: null, locationAnonymized: true });
    expect(client.release).toHaveBeenCalled();
    expect(pool.queries.some((q) => q.sql.includes('DELETE FROM emergencia_contexto_zona'))).toBe(true);
    const scrub = pool.queries.find((q) => q.sql.includes('UPDATE outbox_events'));
    expect(scrub.params[0]).toEqual(['e-1']);
  });

  it('una RESOLVED se cierra y una despachada se cancela liberando al oficial', async () => {
    const resolved = txClient({ ...ROW, id: 'e-res', status: 'RESOLVED' }, { assignedOfficerId: 'of-001' });
    const dispatched = txClient({ ...ROW, id: 'e-dis', status: 'EN_ROUTE' }, { assignedOfficerId: 'of-002' });
    const pool = poolFor(['e-res', 'e-dis'], [resolved, dispatched]);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.expireStaleEmergencies(72);

    expect(result.expired).toEqual([
      { id: 'e-res', previousStatus: 'RESOLVED', newStatus: 'CLOSED' },
      { id: 'e-dis', previousStatus: 'EN_ROUTE', newStatus: 'CANCELLED' },
    ]);
    for (const [client, officer] of [[resolved, 'of-001'], [dispatched, 'of-002']]) {
      const release = client.calls.find((c) => c.sql.includes("UPDATE officers SET status = 'disponible'"));
      expect(release.params).toEqual([officer]);
    }
  });

  it('sin ubicación (o ya anonimizada) cambia el estado y no toca el outbox', async () => {
    const sinUbicacion = txClient({ ...ROW, id: 'e-a', location_encrypted: null });
    const yaAnonimizada = txClient({ ...ROW, id: 'e-b', location_anonymized_at: '2026-11-01' });
    const pool = poolFor(['e-a', 'e-b'], [sinUbicacion, yaAnonimizada]);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    const result = await repo.expireStaleEmergencies(72);

    expect(result.expiredCount).toBe(2);
    for (const client of [sinUbicacion, yaAnonimizada]) {
      expect(client.calls.some((c) => c.sql.includes('SET location_encrypted = NULL'))).toBe(false);
    }
    expect(pool.queries.some((q) => q.sql.includes('UPDATE outbox_events'))).toBe(false);
  });

  it('si otra transacción ya la cambió o la tiene tomada, la saltea', async () => {
    const client = txClient(null);
    const pool = poolFor(['e-1'], [client]);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });

    await expect(repo.expireStaleEmergencies(72)).resolves.toEqual({ expiredCount: 0, failedCount: 0, expired: [] });
    expect(client.calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('una que falla hace ROLLBACK, se cuenta y no frena a la siguiente', async () => {
    const broken = txClient(ROW, { failOn: 'INSERT INTO emergency_status_history' });
    const fine = txClient({ ...ROW, id: 'e-2' });
    const pool = poolFor(['e-1', 'e-2'], [broken, fine]);
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await repo.expireStaleEmergencies(72);
    errorSpy.mockRestore();

    expect(result).toEqual({
      expiredCount: 1, failedCount: 1, expired: [{ id: 'e-2', previousStatus: 'PENDING', newStatus: 'CANCELLED' }],
    });
    expect(broken.calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
    expect(broken.release).toHaveBeenCalled();
    // La que se revirtió no se cuenta como anonimizada.
    expect(pool.queries.find((q) => q.sql.includes('UPDATE outbox_events')).params[0]).toEqual(['e-2']);
  });
});

describe('EmergencyRepository.updateStatus con expiration', () => {
  function clientIn(status) {
    return createClient(async (sql, params) => {
      if (sql.startsWith('SELECT status, assigned_officer_id')) return { rows: [{ status, assigned_officer_id: null }] };
      if (sql.includes('UPDATE emergencies')) return { rows: [{ id: 'e-1', status: params[0] }] };
      if (sql.includes('INSERT INTO emergency_status_history')) return { rows: [{ id: 1, new_status: params[2] }] };
      return { rows: [] };
    });
  }

  it('permite la transición del sistema que los endpoints no tienen (despachada → cancelada)', async () => {
    const client = clientIn('DISPATCHED');
    const repo = new EmergencyRepository(createPool({ client }), { locationCrypto: fakeCrypto });

    const result = await repo.updateStatus('e-1', { newStatus: 'CANCELLED', expiration: true });

    expect(result.emergency.status).toBe('CANCELLED');
    expect(client.calls.map((c) => c.sql).at(-1)).toBe('COMMIT');
  });

  it('sin expiration esa transición sigue rechazada', async () => {
    const client = clientIn('DISPATCHED');
    const repo = new EmergencyRepository(createPool({ client }), { locationCrypto: fakeCrypto });

    await expect(repo.updateStatus('e-1', { newStatus: 'CANCELLED' })).rejects.toThrow(ConflictError);
  });

  it('con expiration solo acepta el estado terminal que le corresponde', async () => {
    const repo = (status) => new EmergencyRepository(createPool({ client: clientIn(status) }), { locationCrypto: fakeCrypto });

    await expect(repo('RESOLVED').updateStatus('e-1', { newStatus: 'CANCELLED', expiration: true }))
      .rejects.toThrow('cannot expire to CANCELLED');
    await expect(repo('CLOSED').updateStatus('e-1', { newStatus: 'CANCELLED', expiration: true }))
      .rejects.toThrow(ConflictError);
    await expect(repo('PENDING').updateStatus('e-1', { newStatus: 'VALIDATED', expiration: true }))
      .rejects.toThrow(ConflictError);
  });
});
