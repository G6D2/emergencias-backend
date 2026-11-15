const { randomUUID } = require('crypto');
const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyCreatedEvent } = require('../../../services/emergency-events');

const CREAR_EMERGENCIA_BICICLETA = 'CrearEmergenciaBicicleta';
const CAUSA_TIPO = 'MOVILIDAD_BICICLETA';
const EMERGENCY_TYPE = 'MEDICA';
const PRIORIDAD_TO_SEVERITY = Object.freeze({
  P1: 'critical',
  P2: 'high',
  P3: 'medium',
  P4: 'low',
});
const UNIQUE_VIOLATION = '23505';
const UNIQUE_CAUSA = 'uq_emergencies_movilidad_bicicleta_causa';
const SAVEPOINT = 'crear_emergencia_bicicleta';
const MAX_DESCRIPTION_LENGTH = 280;

function emergenciaCreadaTopic() {
  return process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico';
}

function descriptionFor(payload) {
  const tripAndBike = [];
  if (payload.viajeId !== undefined && payload.viajeId !== null) {
    tripAndBike.push(`viaje ${payload.viajeId}`);
  }
  if (typeof payload.bicicletaCodigo === 'string' && payload.bicicletaCodigo.trim()) {
    tripAndBike.push(`bicicleta ${payload.bicicletaCodigo.trim()}`);
  }

  const triage = payload.triage || {};
  const indicators = [];
  if (triage.respondido === false) indicators.push('sin respuestas de triage');
  if (triage.estaSangrando === true) indicators.push('sangrado reportado');
  if (triage.puedeMoverse === false) indicators.push('no puede moverse');
  if (triage.vehiculoInvolucrado === true) indicators.push('vehículo involucrado');

  const context = tripAndBike.length > 0 ? ` (${tripAndBike.join(', ')})` : '';
  const details = indicators.length > 0 ? `; ${indicators.join(', ')}` : '';
  return `Asistencia médica en viaje de bicicleta pública${context}. Triage ${payload.prioridadSugerida}${details}.`
    .slice(0, MAX_DESCRIPTION_LENGTH);
}

function isDuplicate(error) {
  return Boolean(error) && error.code === UNIQUE_VIOLATION && error.constraint === UNIQUE_CAUSA;
}

function createCrearEmergenciaBicicletaHandler({
  emergencyRepository,
  topic = emergenciaCreadaTopic(),
}) {
  if (!emergencyRepository) {
    throw new Error('createCrearEmergenciaBicicletaHandler requiere emergencyRepository');
  }

  return async function crearEmergenciaBicicleta(client, payload) {
    const {
      emergenciaId,
      latitud,
      longitud,
      prioridadSugerida,
    } = payload || {};
    if (typeof emergenciaId !== 'string' || !emergenciaId || emergenciaId !== emergenciaId.trim()) {
      throw new ValidationError('CrearEmergenciaBicicleta requiere emergenciaId no vacío');
    }
    if (!Object.prototype.hasOwnProperty.call(PRIORIDAD_TO_SEVERITY, prioridadSugerida)) {
      throw new ValidationError('CrearEmergenciaBicicleta requiere una prioridad P1-P4');
    }
    if (
      !Number.isFinite(latitud)
      || latitud < -90
      || latitud > 90
      || !Number.isFinite(longitud)
      || longitud < -180
      || longitud > 180
    ) {
      throw new ValidationError('CrearEmergenciaBicicleta requiere coordenadas válidas');
    }

    const causa = { causaTipo: CAUSA_TIPO, causaId: emergenciaId };
    const existing = await emergencyRepository.findByCausa(client, causa);
    if (existing.length > 0) {
      secureLog('info', 'Emergencia de bicicleta ya creada', {
        movilidadEmergencyId: emergenciaId,
        emergencyId: existing[0].id,
      });
      return { emergencyId: existing[0].id, created: false };
    }

    const emergencyId = randomUUID();
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      await emergencyRepository.create({
        client,
        id: emergencyId,
        correlationId: emergenciaId,
        userId: null,
        latitude: latitud,
        longitude: longitud,
        description: descriptionFor(payload),
        severity: PRIORIDAD_TO_SEVERITY[prioridadSugerida],
        emergencyType: EMERGENCY_TYPE,
        status: 'PENDING',
        source: 'EXTERNAL',
        requiresManualValidation: false,
        causaTipo: CAUSA_TIPO,
        causaId: emergenciaId,
        outboxEvent: {
          topic,
          payload: (savedEmergency, eventId) => buildEmergencyCreatedEvent(savedEmergency, eventId),
        },
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      const [winner] = await emergencyRepository.findByCausa(client, causa);
      if (!winner) {
        error.transient = true;
        throw error;
      }
      secureLog('info', 'Emergencia de bicicleta creada en paralelo por otro evento', {
        movilidadEmergencyId: emergenciaId,
        emergencyId: winner.id,
      });
      return { emergencyId: winner.id, created: false };
    }
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);

    secureLog('info', 'Emergencia de bicicleta creada', {
      movilidadEmergencyId: emergenciaId,
      emergencyId,
      severity: PRIORIDAD_TO_SEVERITY[prioridadSugerida],
    });
    return { emergencyId, created: true };
  };
}

module.exports = {
  CREAR_EMERGENCIA_BICICLETA,
  CAUSA_TIPO,
  EMERGENCY_TYPE,
  PRIORIDAD_TO_SEVERITY,
  createCrearEmergenciaBicicletaHandler,
};
