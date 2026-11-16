const { randomUUID } = require('crypto');
const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyCreatedEvent, buildEmergencyUpdatedEvent } = require('../../../services/emergency-events');
const { CAUSA_TIPO_CLIMA, NIVEL_TO_SEVERITY } = require('../../../domain/alerta-climatica');

const CREAR_EMERGENCIA_CLIMATICA = 'CrearEmergenciaClimatica';
const CANCELAR_EMERGENCIA_CLIMATICA = 'CancelarEmergenciaClimatica';
const EMERGENCY_TYPE = 'PREVENTIVA';
const ACTOR = 'eda:espacios';
const REASON = 'Alerta climática finalizada';
const CANCELLABLE_STATUSES = new Set(['PENDING', 'VALIDATED']);
const UNIQUE_VIOLATION = '23505';
const UNIQUE_CAUSA = 'uq_emergencies_preventiva_causa';
const SAVEPOINT = 'crear_emergencia_climatica';
const MAX_DESCRIPTION_LENGTH = 200;

function emergenciaCreadaTopic() {
  return process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico';
}

function emergenciaActualizadaTopic() {
  return process.env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado';
}

function descriptionFor({ nivel, fenomeno, barrios = [] }) {
  const que = typeof fenomeno === 'string' && fenomeno.trim()
    ? fenomeno.trim().replace(/_/g, ' ').toLowerCase()
    : 'evento climático';
  const donde = barrios.length > 0 ? ` (${barrios.join(', ')})` : '';
  return `Alerta climática ${nivel} — ${que}${donde}`.slice(0, MAX_DESCRIPTION_LENGTH);
}

function isDuplicate(error) {
  return Boolean(error) && error.code === UNIQUE_VIOLATION && error.constraint === UNIQUE_CAUSA;
}

// Crea una emergencia PREVENTIVA por alerta climática confirmada (ALTA o
// CRITICA): despliegue preventivo mientras dura la alerta. Una sola por
// alertaId (índice único de V23 sobre las PREVENTIVA). La ubicación es el
// primer punto de la alerta; sin puntos queda para validación manual.
//
// prioridadOriginal: la prioridad de la alerta no pasa por ningún ajuste
// climático, así que en EmergenciaCreada sale igual a `prioridad`
// (buildEmergencyCreatedEvent). Las PREVENTIVA no se vinculan a contextos de
// zona, así que tampoco la sube su propia alerta.
function createCrearEmergenciaClimaticaHandler({ emergencyRepository, topic = emergenciaCreadaTopic() }) {
  if (!emergencyRepository) throw new Error('createCrearEmergenciaClimaticaHandler requiere emergencyRepository');

  return async function crearEmergenciaClimatica(client, payload) {
    const {
      alertaId, nivel, fenomeno, latitud = null, longitud = null, barrios = [],
    } = payload || {};
    if (typeof alertaId !== 'string' || !alertaId) {
      throw new ValidationError('CrearEmergenciaClimatica requiere alertaId');
    }
    if (!Object.prototype.hasOwnProperty.call(NIVEL_TO_SEVERITY, nivel)) {
      throw new ValidationError('CrearEmergenciaClimatica requiere nivel BAJA, MEDIA, ALTA o CRITICA');
    }

    const causa = { causaTipo: CAUSA_TIPO_CLIMA, causaId: alertaId, emergencyType: EMERGENCY_TYPE };
    const existing = await emergencyRepository.findByCausa(client, causa);
    if (existing.length > 0) {
      secureLog('info', 'Emergencia climática ya creada', { alertaId, emergencyId: existing[0].id });
      return { emergencyId: existing[0].id, created: false };
    }

    const hasLocation = Number.isFinite(latitud) && Number.isFinite(longitud);
    const severity = NIVEL_TO_SEVERITY[nivel];
    const emergencyId = randomUUID();

    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      await emergencyRepository.create({
        client,
        id: emergencyId,
        correlationId: emergencyId,
        userId: null,
        latitude: hasLocation ? latitud : null,
        longitude: hasLocation ? longitud : null,
        barrioText: barrios[0] || null,
        description: descriptionFor({ nivel, fenomeno, barrios }),
        severity,
        emergencyType: EMERGENCY_TYPE,
        status: 'PENDING',
        source: 'EXTERNAL',
        requiresManualValidation: !hasLocation,
        causaTipo: CAUSA_TIPO_CLIMA,
        causaId: alertaId,
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
      secureLog('info', 'Emergencia climática creada en paralelo por otro evento', {
        alertaId,
        emergencyId: winner.id,
      });
      return { emergencyId: winner.id, created: false };
    }
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);

    secureLog('info', 'Emergencia climática creada', {
      alertaId,
      emergencyId,
      severity,
      requiresManual: !hasLocation,
    });
    return { emergencyId, created: true };
  };
}

// Cuando Espacios finaliza la alerta, la emergencia climática que nadie
// despachó (PENDING/VALIDATED) se cancela. Si ya avanzó, queda como está.
function createCancelarEmergenciaClimaticaHandler({ emergencyRepository, topic = emergenciaActualizadaTopic() }) {
  if (!emergencyRepository) throw new Error('createCancelarEmergenciaClimaticaHandler requiere emergencyRepository');

  return async function cancelarEmergenciaClimatica(client, payload) {
    const { alertaId } = payload || {};
    if (typeof alertaId !== 'string' || !alertaId) {
      throw new ValidationError('CancelarEmergenciaClimatica requiere alertaId');
    }

    const emergencias = await emergencyRepository.findByCausa(client, {
      causaTipo: CAUSA_TIPO_CLIMA,
      causaId: alertaId,
      emergencyType: EMERGENCY_TYPE,
    });

    let cancelled = 0;
    for (const emergencia of emergencias) {
      if (!CANCELLABLE_STATUSES.has(emergencia.status)) {
        secureLog('info', 'Emergencia climática no cancelada: ya avanzó', {
          alertaId,
          emergencyId: emergencia.id,
          status: emergencia.status,
        });
        continue;
      }
      await emergencyRepository.updateStatus(emergencia.id, {
        client,
        newStatus: 'CANCELLED',
        actor: ACTOR,
        reason: REASON,
        outboxEvent: {
          topic,
          payload: ({ emergency, history }, eventId) => buildEmergencyUpdatedEvent({
            emergency,
            history,
            actor: ACTOR,
            reason: REASON,
            eventId,
          }),
        },
      });
      cancelled += 1;
    }

    secureLog('info', 'Alerta climática finalizada', { alertaId, cancelled });
    return { cancelled };
  };
}

module.exports = {
  CREAR_EMERGENCIA_CLIMATICA,
  CANCELAR_EMERGENCIA_CLIMATICA,
  EMERGENCY_TYPE,
  createCrearEmergenciaClimaticaHandler,
  createCancelarEmergenciaClimaticaHandler,
};
