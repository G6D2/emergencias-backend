const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../db/pool');
const { EmergencyRepository } = require('../repositories/emergency.repository');
const { IncidentRepository } = require('../repositories/incident.repository');
const { processEmergencyTypeCandidates } = require('../domain/incident-detector');

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

  // Replica el loop interno de incident-detection-job.js (runOnce + processDecision)
  // sin el setTimeout/setInterval del job real, para poder correrlo una vez por
  // test contra Postgres real. Elegido como helper local en vez de exportar
  // processDecision desde el job: el job envuelve todo en try/catch y traga
  // errores (secureLog + return), lo que ocultaria fallas reales del test.
  // Si el loop del job cambia, este helper hay que sincronizarlo a mano.
  async function runIncidentDetectionPipeline({
    emergencyType,
    radiusMeters = 300,
    minUniqueCitizens = 2,
    windowMinutes = 15,
  }) {
    const since = new Date(Date.now() - windowMinutes * 60000);
    const candidates = await emergencyRepository.findRecentByType({ emergencyType, since });
    const decisions = processEmergencyTypeCandidates(candidates, {
      radiusMeters,
      minUniqueCitizens,
      emergencyType,
    });

    for (const decision of decisions) {
      if (decision.skippedReason) continue;

      let { incidentId } = decision;
      if (incidentId == null) {
        const incident = await incidentRepository.create({ emergencyType: decision.emergencyType });
        incidentId = incident.id;
      }

      for (const member of decision.members) {
        if (!member.alreadyLinked) {
          await incidentRepository.addMember(incidentId, member.emergencyId);
        }
      }

      await incidentRepository.applyScoringDecision(incidentId, {
        priority: decision.priority,
        score: decision.score,
        reasonCodes: decision.reasonCodes,
        factors: decision.factors,
        algorithmVersion: decision.algorithmVersion,
        members: decision.members,
      });
    }

    return decisions;
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
