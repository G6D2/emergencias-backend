const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { IncidentRepository } = require('../repositories/incident.repository');
const {
  startIncidentDetectionJob,
  detectIncidents,
  DETECTION_LOCK_KEY,
} = require('../services/incident-detection-job');

describe('incident-detection-job pipeline (integración contra Postgres real, sin mocks)', () => {
  let emergencyRepository;
  let incidentRepository;

  beforeAll(() => {
    process.env.LOCATION_ENCRYPTION_KEY =
      process.env.LOCATION_ENCRYPTION_KEY
      || 'flxqyJtbe6+mibyHqK76N6LSnFe0w22hnyDZg9KWIcs=';
    emergencyRepository = new EmergencyRepository(getPool());
    incidentRepository = new IncidentRepository(getPool(), emergencyRepository);
  });

  afterAll(async () => {
    await closePool();
  });

  function buildEmergency(overrides = {}) {
    return {
      id: randomUUID(),
      userId: 'user-123',
      description: 'Test panic button',
      severity: 'high',
      ...overrides,
    };
  }

  // Una pasada del job (detectIncidents, el mismo código que corre runOnce)
  // sin el setTimeout/setInterval ni el try/catch de runOnce, que traga los
  // errores y ocultaría fallas reales del test. Se limita a un tipo para que
  // los datos de otros archivos de integración no se mezclen en el test.
  async function runIncidentDetectionPipeline({
    emergencyType,
    radiusMeters = 300,
    minUniqueCitizens = 2,
    windowMinutes = 15,
  }) {
    await detectIncidents({
      emergencyRepository,
      incidentRepository,
      since: new Date(Date.now() - windowMinutes * 60000),
      radiusMeters,
      minUniqueCitizens,
      emergencyTypes: [emergencyType],
    });
  }

  describe('agrupamiento incremental de un mismo foco (INCENDIO)', () => {
    // Coordenadas propias, lejos del punto default (-34.6037,-58.3816) que
    // usan otros archivos de integración: así ningún candidato ajeno del
    // mismo emergencyType cae dentro del radio de este cluster.
    const BASE_LATITUDE = -31.4201;
    const BASE_LONGITUDE = -64.1888;
    let first;
    let second;
    let sharedIncidentId;

    it('dos emergencias reales, cercanas en espacio/tiempo, sin incidentId previo: terminan con el mismo incidentId', async () => {
      first = buildEmergency({
        emergencyType: 'INCENDIO',
        userId: 'user-foco-1',
        latitude: BASE_LATITUDE,
        longitude: BASE_LONGITUDE,
      });
      second = buildEmergency({
        emergencyType: 'INCENDIO',
        userId: 'user-foco-2',
        latitude: BASE_LATITUDE + 0.0002, // ~22m
        longitude: BASE_LONGITUDE,
      });
      await emergencyRepository.create(first);
      await emergencyRepository.create(second);

      await runIncidentDetectionPipeline({ emergencyType: 'INCENDIO' });

      const foundFirst = await emergencyRepository.findById(first.id);
      const foundSecond = await emergencyRepository.findById(second.id);

      expect(foundFirst.incidentId).toBeTruthy();
      expect(foundFirst.incidentId).toBe(foundSecond.incidentId);
      sharedIncidentId = foundFirst.incidentId;

      const incidentRow = await getPool().query('SELECT * FROM incidents WHERE id = $1', [sharedIncidentId]);
      expect(incidentRow.rows).toHaveLength(1);
      expect(incidentRow.rows[0].emergency_type).toBe('INCENDIO');
      expect(incidentRow.rows[0].priority).not.toBeNull();
    });

    it('una tercera emergencia cercana llegada despues se suma al MISMO incidente existente', async () => {
      const third = buildEmergency({
        emergencyType: 'INCENDIO',
        userId: 'user-foco-3',
        latitude: BASE_LATITUDE + 0.0001, // ~11m, entre first y second
        longitude: BASE_LONGITUDE,
      });
      await emergencyRepository.create(third);

      await runIncidentDetectionPipeline({ emergencyType: 'INCENDIO' });

      const foundThird = await emergencyRepository.findById(third.id);
      expect(foundThird.incidentId).toBe(sharedIncidentId);

      const membersOfIncident = await getPool().query(
        'SELECT id FROM emergencies WHERE incident_id = $1',
        [sharedIncidentId]
      );
      expect(membersOfIncident.rows.map((row) => row.id).sort()).toEqual(
        [first.id, second.id, third.id].sort()
      );
    });
  });

  // Hallazgo de docs/ml/calibracion-dbscan.md: cuando el primer reporte
  // cumplía 15 min, el job puntuaba el incidente solo con los otros dos, la
  // prioridad volvía de high a medium y salía EmergenciaPriorizada con la
  // baja. Mismo caso que la demo: tres ciudadanos, DISTURBIO_EVENTO_MASIVO
  // (medium), a menos de 71 m entre sí.
  describe('incidente de la demo cuando el reloj pasa la ventana (DISTURBIO_EVENTO_MASIVO)', () => {
    const BASE_LATITUDE = -26.8083;
    const BASE_LONGITUDE = -65.2176;
    const TYPE = 'DISTURBIO_EVENTO_MASIVO';

    async function setCreatedSecondsAgo(emergencies, secondsAgo) {
      for (let i = 0; i < emergencies.length; i += 1) {
        await getPool().query(
          'UPDATE emergencies SET created_at = now() - make_interval(secs => $1) WHERE id = $2',
          [secondsAgo[i], emergencies[i].id]
        );
      }
    }

    async function prioritizedEventsFor(incidentId) {
      const { rows } = await getPool().query(
        "SELECT payload FROM outbox_events WHERE topic = 'emergencias.priorizada'"
      );
      return rows.map((row) => row.payload).filter((payload) => payload.data.incidentId === incidentId);
    }

    it('el score y la prioridad no bajan y no se publica una EmergenciaPriorizada de baja', async () => {
      const reports = [
        buildEmergency({
          emergencyType: TYPE, severity: 'medium', userId: 'user-demo-1', latitude: BASE_LATITUDE, longitude: BASE_LONGITUDE,
        }),
        buildEmergency({
          emergencyType: TYPE, severity: 'medium', userId: 'user-demo-2', latitude: BASE_LATITUDE + 0.0004, longitude: BASE_LONGITUDE,
        }),
        buildEmergency({
          emergencyType: TYPE, severity: 'medium', userId: 'user-demo-3', latitude: BASE_LATITUDE, longitude: BASE_LONGITUDE + 0.0006,
        }),
      ];
      for (const report of reports) {
        await emergencyRepository.create(report);
      }

      // t = 1,5 min: los tres reportes llegaron en t = 0, 30 s y 60 s.
      await setCreatedSecondsAgo(reports, [90, 60, 30]);
      await runIncidentDetectionPipeline({ emergencyType: TYPE });

      const { incidentId } = await emergencyRepository.findById(reports[0].id);
      expect(incidentId).toBeTruthy();
      const formed = (await getPool().query('SELECT priority, score, factors FROM incidents WHERE id = $1', [incidentId])).rows[0];
      expect(formed.priority).toBe('high');
      expect(formed.factors.reportCount).toBe(3);
      const eventsWhenFormed = await prioritizedEventsFor(incidentId);
      expect(eventsWhenFormed).toHaveLength(3);

      // t = 15¼ min: el primer reporte ya salió de la ventana de 15 min y los
      // otros dos siguen adentro, así que DBSCAN vuelve a armar el grupo.
      await setCreatedSecondsAgo(reports, [915, 885, 855]);
      await runIncidentDetectionPipeline({ emergencyType: TYPE });

      const later = (await getPool().query('SELECT priority, score, factors FROM incidents WHERE id = $1', [incidentId])).rows[0];
      expect(later.priority).toBe('high');
      expect(later.factors.reportCount).toBe(3);
      expect(Number(later.score)).toBeGreaterThanOrEqual(50);

      const eventsLater = await prioritizedEventsFor(incidentId);
      expect(eventsLater).toHaveLength(3);
      expect(eventsLater.every((payload) => payload.data.incidentPriority === 'high')).toBe(true);
    });
  });

  describe('caso ambiguo (MEDICA)', () => {
    const BASE_LATITUDE = -38.0055;
    const BASE_LONGITUDE = -57.5426;

    it('dos incidentes existentes y separados, una emergencia nueva que conecta a ambos por radio: el pipeline no toca ninguno', async () => {
      const incidentA = await incidentRepository.create({ emergencyType: 'MEDICA', priority: 'low' });
      const incidentB = await incidentRepository.create({ emergencyType: 'MEDICA', priority: 'low' });

      // A y bridge, y bridge y B, estan a ~195m entre si (dentro del radio de
      // 300m); A y B directamente estan a ~390m (fuera de radio). Solo se
      // conectan por transitividad a traves de bridge (ver comentario de
      // agrupamiento por cadena en rule-based-grouper.js).
      const memberA = buildEmergency({
        emergencyType: 'MEDICA',
        userId: 'user-amb-a',
        latitude: BASE_LATITUDE,
        longitude: BASE_LONGITUDE,
      });
      const memberB = buildEmergency({
        emergencyType: 'MEDICA',
        userId: 'user-amb-b',
        latitude: BASE_LATITUDE + 0.0035,
        longitude: BASE_LONGITUDE,
      });
      await emergencyRepository.create(memberA);
      await emergencyRepository.create(memberB);
      await incidentRepository.addMember(incidentA.id, memberA.id);
      await incidentRepository.addMember(incidentB.id, memberB.id);

      const bridging = buildEmergency({
        emergencyType: 'MEDICA',
        userId: 'user-amb-bridge',
        latitude: BASE_LATITUDE + 0.00175,
        longitude: BASE_LONGITUDE,
      });
      await emergencyRepository.create(bridging);

      await runIncidentDetectionPipeline({ emergencyType: 'MEDICA' });

      const rawA = await getPool().query('SELECT priority, score FROM incidents WHERE id = $1', [incidentA.id]);
      const rawB = await getPool().query('SELECT priority, score FROM incidents WHERE id = $1', [incidentB.id]);
      expect(rawA.rows[0].priority).toBe('low');
      expect(rawA.rows[0].score).toBeNull();
      expect(rawB.rows[0].priority).toBe('low');
      expect(rawB.rows[0].score).toBeNull();

      const foundBridging = await emergencyRepository.findById(bridging.id);
      expect(foundBridging.incidentId).toBeNull();

      const foundMemberA = await emergencyRepository.findById(memberA.id);
      const foundMemberB = await emergencyRepository.findById(memberB.id);
      expect(foundMemberA.incidentId).toBe(incidentA.id);
      expect(foundMemberB.incidentId).toBe(incidentB.id);
    });
  });

  describe('job real: runOnce() con el lock de transacción y una sola query de candidatos', () => {
    // Coordenadas propias (Mendoza), lejos de los otros clusters del archivo.
    const BASE_LATITUDE = -32.8895;
    const BASE_LONGITUDE = -68.8458;

    function createJob() {
      const job = startIncidentDetectionJob(emergencyRepository, incidentRepository, {
        pool: getPool(),
        env: { INCIDENT_DETECTION_INTERVAL_MS: '60000' },
      });
      job.stop();
      return job;
    }

    const isCandidateQuery = ([sql]) => typeof sql === 'string' && sql.includes('emergency_type = ANY');

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('agrupa PANICO y MEDICA con una sola query, sin sumar la emergencia cancelada', async () => {
      const panicoA = buildEmergency({
        emergencyType: 'PANICO', userId: 'user-mza-1', latitude: BASE_LATITUDE, longitude: BASE_LONGITUDE,
      });
      const panicoB = buildEmergency({
        emergencyType: 'PANICO', userId: 'user-mza-2', latitude: BASE_LATITUDE + 0.0002, longitude: BASE_LONGITUDE,
      });
      const panicoCancelado = buildEmergency({
        emergencyType: 'PANICO', userId: 'user-mza-3', latitude: BASE_LATITUDE + 0.0001, longitude: BASE_LONGITUDE,
      });
      const medicaA = buildEmergency({
        emergencyType: 'MEDICA', userId: 'user-mza-4', latitude: BASE_LATITUDE, longitude: BASE_LONGITUDE,
      });
      const medicaB = buildEmergency({
        emergencyType: 'MEDICA', userId: 'user-mza-5', latitude: BASE_LATITUDE + 0.0002, longitude: BASE_LONGITUDE,
      });
      for (const emergency of [panicoA, panicoB, panicoCancelado, medicaA, medicaB]) {
        await emergencyRepository.create(emergency);
      }
      await getPool().query("UPDATE emergencies SET status = 'CANCELLED' WHERE id = $1", [panicoCancelado.id]);

      const querySpy = jest.spyOn(getPool(), 'query');
      await createJob().runOnce();

      expect(querySpy.mock.calls.filter(isCandidateQuery)).toHaveLength(1);

      const foundPanicoA = await emergencyRepository.findById(panicoA.id);
      const foundPanicoB = await emergencyRepository.findById(panicoB.id);
      const foundCancelado = await emergencyRepository.findById(panicoCancelado.id);
      const foundMedicaA = await emergencyRepository.findById(medicaA.id);
      const foundMedicaB = await emergencyRepository.findById(medicaB.id);

      expect(foundPanicoA.incidentId).toBeTruthy();
      expect(foundPanicoB.incidentId).toBe(foundPanicoA.incidentId);
      expect(foundCancelado.incidentId).toBeNull();
      expect(foundMedicaA.incidentId).toBeTruthy();
      expect(foundMedicaB.incidentId).toBe(foundMedicaA.incidentId);
      expect(foundMedicaA.incidentId).not.toBe(foundPanicoA.incidentId);

      const { rows } = await getPool().query(
        'SELECT id, emergency_type FROM incidents WHERE id = ANY($1::uuid[])',
        [[foundPanicoA.incidentId, foundMedicaA.incidentId]]
      );
      const typeById = new Map(rows.map((row) => [row.id, row.emergency_type]));
      expect(typeById.get(foundPanicoA.incidentId)).toBe('PANICO');
      expect(typeById.get(foundMedicaA.incidentId)).toBe('MEDICA');
    });

    it('si otra conexión tiene el lock, la corrida se saltea sin buscar candidatos', async () => {
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [DETECTION_LOCK_KEY]);

        const querySpy = jest.spyOn(getPool(), 'query');
        await createJob().runOnce();

        expect(querySpy.mock.calls.filter(isCandidateQuery)).toHaveLength(0);
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }
    });

    it('el COMMIT suelta el lock: una corrida termina y la siguiente lo vuelve a tomar', async () => {
      const job = createJob();
      await job.runOnce();

      const querySpy = jest.spyOn(getPool(), 'query');
      await job.runOnce();

      expect(querySpy.mock.calls.filter(isCandidateQuery)).toHaveLength(1);
      const { rows } = await getPool().query(
        "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1",
        [DETECTION_LOCK_KEY]
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('sin agrupamiento posible (OTRO)', () => {
    it('una emergencia sola, sin nadie cerca, no crea ningun incidente', async () => {
      const lone = buildEmergency({
        emergencyType: 'OTRO',
        userId: 'user-lone',
        latitude: -24.7859,
        longitude: -65.4117,
      });
      await emergencyRepository.create(lone);

      await runIncidentDetectionPipeline({ emergencyType: 'OTRO' });

      const found = await emergencyRepository.findById(lone.id);
      expect(found.incidentId).toBeNull();
    });
  });
});
