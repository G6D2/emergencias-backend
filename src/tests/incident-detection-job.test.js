const { startIncidentDetectionJob } = require('../services/incident-detection-job');

const BASE_LATITUDE = -34.6037;
const BASE_LONGITUDE = -58.3816;

function closeCandidate(overrides = {}) {
  return {
    id: 'default-id',
    correlationId: 'default-id',
    userId: 'default-user',
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
    emergencyRepository.findRecentByType.mockImplementation(({ emergencyType }) => (
      Promise.resolve(emergencyType === 'INCENDIO' ? candidates : [])
    ));
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
    emergencyRepository.findRecentByType.mockImplementation(({ emergencyType }) => (
      Promise.resolve(emergencyType === 'INCENDIO' ? candidates : [])
    ));

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
    emergencyRepository.findRecentByType.mockImplementation(({ emergencyType }) => (
      Promise.resolve(emergencyType === 'INCENDIO' ? candidates : [])
    ));

    const job = createJob(emergencyRepository, incidentRepository);
    await job.runOnce();

    expect(incidentRepository.create).not.toHaveBeenCalled();
    expect(incidentRepository.addMember).not.toHaveBeenCalled();
    expect(incidentRepository.applyScoringDecision).not.toHaveBeenCalled();
  });

  it('si findRecentByType rechaza para un tipo, runOnce() no relanza y el job sigue funcionando en la siguiente corrida', async () => {
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
});
