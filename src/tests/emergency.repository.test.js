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
    // Sin ubicación no se cifra nada.
    expect(insert.params[3]).toBeNull();
    expect(insert.params.slice(8)).toEqual(['EXTERNAL', true, 'EVENTO_PUBLICO', 'ev-1']);
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

describe('EmergencyRepository.anonymizeExpiredLocations', () => {
  it('rechaza retentionHours no positivo', async () => {
    const pool = createPool();
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    await expect(repo.anonymizeExpiredLocations(0)).rejects.toThrow('retentionHours must be a positive number');
    await expect(repo.anonymizeExpiredLocations('nope')).rejects.toThrow('retentionHours must be a positive number');
  });

  it('anonimiza y devuelve ids afectados', async () => {
    const queries = [];
    const pool = createPool({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rowCount: 2, rows: [{ id: 'e-1' }, { id: 'e-2' }] };
      },
    });
    const repo = new EmergencyRepository(pool, { locationCrypto: fakeCrypto });
    const result = await repo.anonymizeExpiredLocations(72);
    expect(result).toEqual({ anonymizedCount: 2, ids: ['e-1', 'e-2'] });
    expect(queries[0].sql).toMatch(/closed_at IS NOT NULL/);
    expect(queries[0].sql).toMatch(/closed_at < now\(\)/);
    expect(queries[0].sql).not.toMatch(/created_at </);
    expect(queries[0].params).toEqual([72]);
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
      query: async (sql, params) => ({ rows: [{ id: params[0], location_encrypted: params[3] }] }),
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
