const {
  startIncidentDetectionJob,
  withDetectionLock,
  detectIncidents,
  DETECTION_LOCK_KEY,
  GROUPABLE_EMERGENCY_TYPES,
} = require('../services/incident-detection-job');
const { TERMINAL_STATUSES } = require('../domain/emergency-status');

const BASE_LATITUDE = -34.6037;
const BASE_LONGITUDE = -58.3816;

function closeCandidate(overrides = {}) {
  return {
    id: 'default-id',
    correlationId: 'default-id',
    userId: 'default-user',
    emergencyType: 'INCENDIO',
    latitude: BASE_LATITUDE,
    longitude: BASE_LONGITUDE,
    createdAt: new Date(),
    severity: 'low',
    incidentId: null,
    ...overrides,
  };
}

function buildRepos() {
  return {
    emergencyRepository: {
      findRecentByType: jest.fn().mockResolvedValue([]),
      findActiveByIncidentIds: jest.fn().mockResolvedValue([]),
    },
    incidentRepository: {
      create: jest.fn(),
      addMember: jest.fn(),
      applyScoringDecision: jest.fn(),
    },
  };
}

// Arranca el job pero corta el setTimeout/setInterval reales de inmediato:
// los tests llaman runOnce() a mano para no depender de temporizadores.
function createJob(emergencyRepository, incidentRepository, envOverrides = {}) {
  const job = startIncidentDetectionJob(emergencyRepository, incidentRepository, {
    env: { ...envOverrides },
  });
  job.stop();
  return job;
}

describe('incident-detection-job', () => {
  describe('validacion de variables de entorno al construirse', () => {
    it.each([
      ['INCIDENT_RADIUS_M', '0'],
      ['INCIDENT_WINDOW_MIN', 'not-a-number'],
      ['INCIDENT_MIN_CITIZENS', '-1'],
      ['INCIDENT_DETECTION_INTERVAL_MS', '500'],
    ])('lanza al construirse si %s es invalida', (envKey, badValue) => {
      const { emergencyRepository, incidentRepository } = buildRepos();

      expect(() => startIncidentDetectionJob(emergencyRepository, incidentRepository, {
        env: { [envKey]: badValue },
      })).toThrow();
    });
  });

  it('INCIDENT_DETECTION_ENABLED=false devuelve un stop() no-op y no llama a los repositories', () => {
    const { emergencyRepository, incidentRepository } = buildRepos();

    const job = startIncidentDetectionJob(emergencyRepository, incidentRepository, {
      env: { INCIDENT_DETECTION_ENABLED: 'false' },
    });

    expect(() => job.stop()).not.toThrow();
    expect(emergencyRepository.findRecentByType).not.toHaveBeenCalled();
    expect(incidentRepository.create).not.toHaveBeenCalled();
    expect(incidentRepository.addMember).not.toHaveBeenCalled();
    expect(incidentRepository.applyScoringDecision).not.toHaveBeenCalled();
  });

  it('runOnce() con un grupo nuevo llama create() y addMember() para cada miembro', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();
    const candidates = [
      closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1' }),
      closeCandidate({ id: 'e2', correlationId: 'e2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002 }),
    ];
    emergencyRepository.findRecentByType.mockResolvedValue(candidates);
    incidentRepository.create.mockResolvedValue({ id: 'incident-1' });

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(incidentRepository.create).toHaveBeenCalledTimes(1);
    expect(incidentRepository.create).toHaveBeenCalledWith({ emergencyType: 'INCENDIO' });
    expect(incidentRepository.addMember).toHaveBeenCalledTimes(2);
    expect(incidentRepository.addMember).toHaveBeenCalledWith('incident-1', 'e1');
    expect(incidentRepository.addMember).toHaveBeenCalledWith('incident-1', 'e2');
    expect(incidentRepository.applyScoringDecision).toHaveBeenCalledTimes(1);
  });

  it('runOnce() no llama addMember() para un miembro ya vinculado (alreadyLinked), pero si aplica el scoring', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();
    const candidates = [
      closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1', incidentId: 'inc-1' }),
      closeCandidate({
        id: 'e2', correlationId: 'e2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002, incidentId: null,
      }),
    ];
    emergencyRepository.findRecentByType.mockResolvedValue(candidates);

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(incidentRepository.create).not.toHaveBeenCalled();
    expect(incidentRepository.addMember).toHaveBeenCalledTimes(1);
    expect(incidentRepository.addMember).toHaveBeenCalledWith('inc-1', 'e2');
    expect(incidentRepository.applyScoringDecision).toHaveBeenCalledTimes(1);
    expect(incidentRepository.applyScoringDecision).toHaveBeenCalledWith('inc-1', expect.any(Object));
  });

  it('un grupo con AMBIGUOUS_EXISTING_INCIDENTS no llama a ningun metodo de los repositories', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();
    const candidates = [
      closeCandidate({ id: 'e1', correlationId: 'e1', userId: 'u1', incidentId: 'inc-1' }),
      closeCandidate({
        id: 'e2', correlationId: 'e2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002, incidentId: 'inc-2',
      }),
    ];
    emergencyRepository.findRecentByType.mockResolvedValue(candidates);

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(incidentRepository.create).not.toHaveBeenCalled();
    expect(incidentRepository.addMember).not.toHaveBeenCalled();
    expect(incidentRepository.applyScoringDecision).not.toHaveBeenCalled();
  });

  it('trae los candidatos de todos los tipos agrupables en una sola query, sin PREVENTIVA', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();

    const job = createJob(emergencyRepository, incidentRepository, { INCIDENT_WINDOW_MIN: '15' });
    const before = Date.now();
    await job.runOnce();

    expect(emergencyRepository.findRecentByType).toHaveBeenCalledTimes(1);
    const [{ emergencyTypes, since }] = emergencyRepository.findRecentByType.mock.calls[0];
    expect(emergencyTypes).toEqual(GROUPABLE_EMERGENCY_TYPES);
    expect(emergencyTypes).toContain('PANICO');
    expect(emergencyTypes).not.toContain('PREVENTIVA');
    expect(before - since.getTime()).toBeGreaterThanOrEqual(15 * 60000);
  });

  it('agrupa en memoria por emergencyType: dos reportes iguales de tipos distintos no se mezclan', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();
    emergencyRepository.findRecentByType.mockResolvedValue([
      closeCandidate({ id: 'f1', userId: 'u1', emergencyType: 'INCENDIO' }),
      closeCandidate({ id: 'm1', userId: 'u2', emergencyType: 'MEDICA' }),
      closeCandidate({
        id: 'f2', userId: 'u3', emergencyType: 'INCENDIO', latitude: BASE_LATITUDE + 0.0002,
      }),
      closeCandidate({
        id: 'm2', userId: 'u4', emergencyType: 'MEDICA', latitude: BASE_LATITUDE + 0.0002,
      }),
    ]);
    incidentRepository.create.mockImplementation(async ({ emergencyType }) => ({ id: `inc-${emergencyType}` }));

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(incidentRepository.create).toHaveBeenCalledTimes(2);
    expect(incidentRepository.create).toHaveBeenCalledWith({ emergencyType: 'INCENDIO' });
    expect(incidentRepository.create).toHaveBeenCalledWith({ emergencyType: 'MEDICA' });
    expect(incidentRepository.addMember.mock.calls).toEqual(expect.arrayContaining([
      ['inc-INCENDIO', 'f1'], ['inc-INCENDIO', 'f2'], ['inc-MEDICA', 'm1'], ['inc-MEDICA', 'm2'],
    ]));
    expect(incidentRepository.addMember).toHaveBeenCalledTimes(4);
  });

  it('con candidatos ya vinculados, pide una sola vez los miembros activos de esos incidentes y los puntúa', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();
    emergencyRepository.findRecentByType.mockResolvedValue([
      closeCandidate({ id: 'e2', userId: 'u2', incidentId: 'inc-1' }),
      closeCandidate({
        id: 'e3', userId: 'u3', incidentId: 'inc-1', latitude: BASE_LATITUDE + 0.0002,
      }),
      closeCandidate({
        id: 'm1', userId: 'u4', emergencyType: 'MEDICA', incidentId: 'inc-2', latitude: BASE_LATITUDE + 1,
      }),
    ]);
    // e1 es del mismo incidente pero ya salió de la ventana.
    emergencyRepository.findActiveByIncidentIds.mockResolvedValue([
      closeCandidate({
        id: 'e1', userId: 'u1', incidentId: 'inc-1', createdAt: new Date(Date.now() - 16 * 60000),
      }),
    ]);

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(emergencyRepository.findActiveByIncidentIds).toHaveBeenCalledTimes(1);
    expect(emergencyRepository.findActiveByIncidentIds.mock.calls[0][0].sort()).toEqual(['inc-1', 'inc-2']);
    expect(incidentRepository.addMember).not.toHaveBeenCalled();
    expect(incidentRepository.applyScoringDecision).toHaveBeenCalledTimes(1);
    const [incidentId, decision] = incidentRepository.applyScoringDecision.mock.calls[0];
    expect(incidentId).toBe('inc-1');
    expect(decision.factors.reportCount).toBe(3);
    expect(decision.members.map((m) => m.emergencyId).sort()).toEqual(['e1', 'e2', 'e3']);
  });

  it('sin candidatos vinculados a un incidente no busca miembros de incidentes', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();
    emergencyRepository.findRecentByType.mockResolvedValue([
      closeCandidate({ id: 'e1', userId: 'u1' }),
      closeCandidate({ id: 'e2', userId: 'u2', latitude: BASE_LATITUDE + 0.0002 }),
    ]);
    incidentRepository.create.mockResolvedValue({ id: 'incident-1' });

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(emergencyRepository.findActiveByIncidentIds).not.toHaveBeenCalled();
    expect(incidentRepository.applyScoringDecision).toHaveBeenCalledTimes(1);
  });

  // Hallazgo de docs/ml/calibracion-dbscan.md: el job puntuaba un incidente
  // solo con los miembros que seguían en la ventana. Cuando el primer
  // reporte cumplía 15 min, el incidente de la demo pasaba de high a medium
  // (score 56 → 42) con sus tres reportes y se publicaba EmergenciaPriorizada
  // con la baja. Repositorios en memoria que se comportan como los reales y
  // un reloj simulado, una pasada por minuto como en producción.
  describe('incidente de la demo con el reloj más allá de la ventana', () => {
    const T0 = Date.UTC(2026, 10, 17, 15, 0, 0);
    const WINDOW_MIN = 15;
    const TYPE = 'DISTURBIO_EVENTO_MASIVO';

    function buildDemo() {
      const emergencies = [
        { id: 'e1', userId: 'JuanPanico', latitude: -34.6037, longitude: -58.3816, createdAtMs: T0 },
        { id: 'e2', userId: 'LuciaTranquila', latitude: -34.6033, longitude: -58.3816, createdAtMs: T0 + 30000 },
        { id: 'e3', userId: 'U000042', latitude: -34.6037, longitude: -58.3810, createdAtMs: T0 + 60000 },
      ].map((emergency) => ({ ...emergency, severity: 'medium', status: 'PENDING', incidentId: null }));
      const incidents = new Map();
      // Como IncidentRepository.applyScoringDecision: una EmergenciaPriorizada
      // por miembro, solo si cambió la prioridad del incidente.
      const prioritizedEvents = [];
      let now = T0;

      const isActive = (emergency) => !TERMINAL_STATUSES.includes(emergency.status);
      const toCandidate = (emergency) => ({
        id: emergency.id,
        correlationId: emergency.id,
        userId: emergency.userId,
        emergencyType: TYPE,
        latitude: emergency.latitude,
        longitude: emergency.longitude,
        severity: emergency.severity,
        incidentId: emergency.incidentId,
        createdAt: new Date(emergency.createdAtMs),
      });

      const emergencyRepository = {
        findRecentByType: jest.fn(async ({ since }) => emergencies
          .filter((e) => isActive(e) && e.createdAtMs >= since.getTime() && e.createdAtMs <= now)
          .map(toCandidate)),
        findActiveByIncidentIds: jest.fn(async (incidentIds) => emergencies
          .filter((e) => isActive(e) && incidentIds.includes(e.incidentId))
          .map(toCandidate)),
      };
      const incidentRepository = {
        create: jest.fn(async () => {
          const id = `inc-${incidents.size + 1}`;
          incidents.set(id, { id, priority: null });
          return { id };
        }),
        addMember: jest.fn(async (incidentId, emergencyId) => {
          emergencies.find((e) => e.id === emergencyId).incidentId = incidentId;
        }),
        applyScoringDecision: jest.fn(async (incidentId, { priority, score, factors, members }) => {
          const incident = incidents.get(incidentId);
          if (incident.priority !== priority) {
            members.forEach((member) => prioritizedEvents.push({
              minute: (now - T0) / 60000, emergencyId: member.emergencyId, incidentPriority: priority,
            }));
          }
          Object.assign(incident, { priority, score, reportCount: factors.reportCount });
        }),
      };

      async function runAt(minute) {
        now = T0 + minute * 60000;
        jest.spyOn(Date, 'now').mockReturnValue(now);
        await detectIncidents({
          emergencyRepository,
          incidentRepository,
          since: new Date(now - WINDOW_MIN * 60000),
          radiusMeters: 300,
          minUniqueCitizens: 2,
        });
        return { minute, ...incidents.get('inc-1') };
      }

      return { emergencies, prioritizedEvents, runAt };
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('el score y la prioridad no bajan cuando los primeros reportes salen de la ventana, ni se publica una baja', async () => {
      const demo = buildDemo();
      const history = [];
      for (let minute = 1.5; minute < 30; minute += 1) {
        history.push(await demo.runAt(minute));
      }

      const at = (minute) => history.find((pass) => pass.minute === minute);
      expect(at(1.5)).toMatchObject({ priority: 'high', reportCount: 3 });
      // En la pasada de 15,5 la ventana ya no tiene a e1 (salió a los 15 min)
      // y todavía tiene a e2 y e3: DBSCAN vuelve a armar el grupo con dos.
      expect(at(15.5)).toMatchObject({ priority: 'high', reportCount: 3 });
      expect(at(15.5).score).toBeGreaterThanOrEqual(50);
      // Solo la recencia le resta (~1 punto por minuto), no la salida de e1.
      expect(at(15.5).score).toBeGreaterThanOrEqual(at(14.5).score - 1);
      history.forEach((pass) => {
        expect(pass.priority).toBe('high');
        expect(pass.reportCount).toBe(3);
      });

      // Una sola EmergenciaPriorizada por miembro: la de cuando se formó.
      expect(demo.prioritizedEvents.map((event) => event.emergencyId).sort()).toEqual(['e1', 'e2', 'e3']);
      expect(demo.prioritizedEvents.every((event) => event.minute === 1.5 && event.incidentPriority === 'high')).toBe(true);
    });

    it('una emergencia que pasa a un estado terminal sí deja de contar y puede bajar la prioridad', async () => {
      const demo = buildDemo();
      await demo.runAt(1.5);

      demo.emergencies.find((e) => e.id === 'e1').status = 'CANCELLED';
      const pass = await demo.runAt(10);

      expect(pass).toMatchObject({ priority: 'medium', reportCount: 2 });
      const events = demo.prioritizedEvents.filter((event) => event.minute === 10);
      expect(events.map((event) => event.emergencyId).sort()).toEqual(['e2', 'e3']);
      expect(events.every((event) => event.incidentPriority === 'medium')).toBe(true);
    });
  });

  it('sin candidatos no toca el repository de incidentes', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(incidentRepository.create).not.toHaveBeenCalled();
    expect(incidentRepository.applyScoringDecision).not.toHaveBeenCalled();
  });

  it('si findRecentByType rechaza, runOnce() no relanza y el job sigue funcionando en la siguiente corrida', async () => {
    const { emergencyRepository, incidentRepository } = buildRepos();
    emergencyRepository.findRecentByType.mockRejectedValueOnce(new Error('db down'));
    emergencyRepository.findRecentByType.mockResolvedValue([]);

    const job = createJob(emergencyRepository, incidentRepository);

    await expect(job.runOnce()).resolves.toBeUndefined();
    expect(incidentRepository.create).not.toHaveBeenCalled();

    const callsAfterFirstRun = emergencyRepository.findRecentByType.mock.calls.length;

    // El job no debe quedar en un estado roto: una segunda corrida vuelve a
    // invocar findRecentByType con normalidad (confirma que el guard de
    // reentrada libero `running` en el finally tras el error).
    await expect(job.runOnce()).resolves.toBeUndefined();
    expect(emergencyRepository.findRecentByType.mock.calls.length).toBeGreaterThan(callsAfterFirstRun);
  });

  describe('withDetectionLock (lock entre instancias, pg_try_advisory_xact_lock)', () => {
    function createLockClient(locked, { commitError = null } = {}) {
      return {
        query: jest.fn(async (sql) => {
          if (sql === 'BEGIN') return { rows: [] };
          if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked }] };
          if (sql === 'COMMIT') {
            if (commitError) throw commitError;
            return { rows: [] };
          }
          throw new Error(`query inesperada: ${sql}`);
        }),
        release: jest.fn(),
      };
    }

    const statements = (client) => client.query.mock.calls.map(([sql]) => (
      /pg_try_advisory_xact_lock/.test(sql) ? 'LOCK' : sql
    ));

    it('sin pool, corre fn() directo (compatibilidad con callers que no pasan pool)', async () => {
      const fn = jest.fn().mockResolvedValue('resultado');

      const result = await withDetectionLock(null, fn);

      expect(result).toBe('resultado');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('lock libre: abre la transacción, toma el lock, corre fn() y el COMMIT lo suelta', async () => {
      const client = createLockClient(true);
      const pool = { connect: jest.fn(async () => client) };
      const fn = jest.fn().mockResolvedValue('ok');

      const result = await withDetectionLock(pool, fn);

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(statements(client)).toEqual(['BEGIN', 'LOCK', 'COMMIT']);
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_xact_lock($1)'), [DETECTION_LOCK_KEY]);
      expect(client.release).toHaveBeenCalledWith(undefined);
    });

    it('apaga idle_in_transaction_session_timeout solo para la transacción del lock', async () => {
      const client = createLockClient(true);
      const pool = { connect: jest.fn(async () => client) };

      await withDetectionLock(pool, jest.fn());

      const lockSql = client.query.mock.calls.find(([sql]) => /pg_try_advisory_xact_lock/.test(sql))[0];
      expect(lockSql).toMatch(/set_config\('idle_in_transaction_session_timeout', '0', true\)/);
    });

    it('lock ocupado: no corre fn(), cierra la transacción y libera la conexión dedicada', async () => {
      const client = createLockClient(false);
      const pool = { connect: jest.fn(async () => client) };
      const fn = jest.fn();

      const result = await withDetectionLock(pool, fn);

      expect(result).toBeUndefined();
      expect(fn).not.toHaveBeenCalled();
      expect(statements(client)).toEqual(['BEGIN', 'LOCK', 'COMMIT']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('cierra la transacción y devuelve la conexión al pool aunque fn() lance', async () => {
      const client = createLockClient(true);
      const pool = { connect: jest.fn(async () => client) };
      const fn = jest.fn().mockRejectedValue(new Error('boom'));

      await expect(withDetectionLock(pool, fn)).rejects.toThrow('boom');

      expect(statements(client)).toEqual(['BEGIN', 'LOCK', 'COMMIT']);
      expect(client.release).toHaveBeenCalledWith(undefined);
    });

    it('si el COMMIT falla, la conexión está rota: se descarta del pool (release con el error)', async () => {
      const commitError = new Error('Connection terminated unexpectedly');
      const client = createLockClient(true, { commitError });
      const pool = { connect: jest.fn(async () => client) };

      await expect(withDetectionLock(pool, jest.fn().mockResolvedValue('ok'))).resolves.toBe('ok');

      expect(client.release).toHaveBeenCalledWith(commitError);
    });

    it('runOnce() con lock ocupado no llama a findRecentByType ni a ningun metodo de los repositories', async () => {
      const { emergencyRepository, incidentRepository } = buildRepos();
      const client = createLockClient(false);
      const pool = { connect: jest.fn(async () => client) };

      const job = startIncidentDetectionJob(emergencyRepository, incidentRepository, { env: {}, pool });
      job.stop();

      await job.runOnce();

      expect(emergencyRepository.findRecentByType).not.toHaveBeenCalled();
      expect(incidentRepository.create).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('runOnce() con lock libre: 4 sentencias en total (BEGIN, lock, la query de candidatos y COMMIT)', async () => {
      const { emergencyRepository, incidentRepository } = buildRepos();
      const client = createLockClient(true);
      const pool = { connect: jest.fn(async () => client) };

      const job = startIncidentDetectionJob(emergencyRepository, incidentRepository, { env: {}, pool });
      job.stop();

      await job.runOnce();

      expect(emergencyRepository.findRecentByType).toHaveBeenCalledTimes(1);
      expect(statements(client)).toEqual(['BEGIN', 'LOCK', 'COMMIT']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });
});
