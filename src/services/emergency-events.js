// Contrato cerrado por Juani en issue #48 (comment 6589800911, 2026-11-02).
// Reemplaza los criterios originales del issue; refleja lo que leen reclamos,
// espacios, movilidad, residuos y analitica + lo acordado con Analitica el
// 29/10. La traduccion se hace solo al armar el evento: la base no cambia.
//
// Extensión: ubicacion.latitud/longitud van cifrados con BUS_LOCATION_ENCRYPTION_KEY
// (solo anidados; no hay latitud/longitud en la raíz de data).

const { getBusLocationCrypto } = require('../security/bus-location-crypto');
const { secureLog } = require('../security/secure-log');

const SEVERITY_TO_PRIORIDAD = {
  low: 'BAJA',
  medium: 'MEDIA',
  high: 'ALTA',
  critical: 'CRITICA',
};

const STATUS_TO_ESTADO = {
  PENDING: 'PENDIENTE',
  VALIDATED: 'VALIDADA',
  DISPATCHED: 'DESPACHADA',
  EN_ROUTE: 'EN_CAMINO',
  ON_SCENE: 'EN_LUGAR',
  RESOLVED: 'RESUELTA',
  CLOSED: 'CERRADA',
  DISCARDED: 'DESCARTADA',
  CANCELLED: 'CANCELADA',
};

function toPrioridad(severity) {
  if (!severity) return null;
  return SEVERITY_TO_PRIORIDAD[String(severity).toLowerCase()] || null;
}

function toEstado(status) {
  if (!status) return null;
  return STATUS_TO_ESTADO[String(status).toUpperCase()] || null;
}

function encryptBusCoords(emergency, busCrypto) {
  const lat = emergency.latitude;
  const lng = emergency.longitude;
  if (!busCrypto) return { latitud: null, longitud: null };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { latitud: null, longitud: null };
  }
  try {
    return {
      latitud: busCrypto.encryptCoordinate(lat),
      longitud: busCrypto.encryptCoordinate(lng),
    };
  } catch (error) {
    secureLog('warn', 'Failed to encrypt bus coordinates; publishing null', {
      emergencyId: emergency.id,
      message: error.message,
    });
    return { latitud: null, longitud: null };
  }
}

function buildEmergencyCreatedEvent(emergency, eventId, options = {}) {
  const correlationId = emergency.correlationId || emergency.id;
  const busCrypto = options.busCrypto !== undefined
    ? options.busCrypto
    : getBusLocationCrypto();
  const encrypted = encryptBusCoords(emergency, busCrypto);

  return {
    type: 'EmergenciaCreada',
    eventId,
    correlationId,
    data: {
      emergenciaId: emergency.id,
      categoria: emergency.emergencyType ?? null,
      prioridad: toPrioridad(emergency.severity),
      estado: toEstado(emergency.status),
      // Catálogo oficial CABA (PIP en create / texto solo si matchea).
      // Plano para Reclamos y Analitica; anidado para Espacios.
      barrio: emergency.barrio ?? null,
      ubicacion: {
        barrio: emergency.barrio ?? null,
        // Ciphertext AES-GCM (clave de bus); no se publican en la raíz de data.
        latitud: encrypted.latitud,
        longitud: encrypted.longitud,
      },
      // Null hasta #85: con false, Reclamos descarta el evento sin
      // escalar. Los demas consumidores toman null como "no afecta".
      afectaCirculacion: null,
      causaId: emergency.causaId ?? null,
      causaTipo: emergency.causaTipo ?? null,
      prioridadOriginal: null,
      ciudadanoId: emergency.userId ?? null,
      correlationId,
      createdAt: emergency.createdAt,
    },
  };
}

function buildEmergencyUpdatedEvent({ emergency, history, actor, reason, eventId }) {
  const correlationId = emergency.correlationId || emergency.id;
  const estadoNuevo = toEstado(history.newStatus);
  return {
    type: 'EmergenciaActualizada',
    eventId,
    correlationId,
    data: {
      emergenciaId: emergency.id,
      estadoAnterior: toEstado(history.previousStatus),
      estadoNuevo,
      updatedAt: emergency.updatedAt || new Date().toISOString(),
      resueltoAt: estadoNuevo === 'RESUELTA' ? (emergency.resolvedAt || new Date().toISOString()) : null,
      usuarioId: actor ?? null,
      asignadoA: estadoNuevo === 'DESPACHADA' ? (emergency.assignedOfficerId ?? null) : null,
      areaResponsable: null,
      resolucion: reason ?? null,
      prioridad: toPrioridad(emergency.severity),
      correlationId,
    },
  };
}

function buildEmergencyPrioritizedEvent({
  emergencyId,
  correlationId,
  incidentId,
  priorityIndividual,
  incidentPriority,
  priority,
  score,
  reasonCodes,
  algorithmVersion,
  eventId,
}) {
  return {
    type: 'EmergenciaPriorizada',
    eventId,
    correlationId: correlationId || emergencyId,
    data: {
      id: emergencyId,
      correlationId: correlationId || emergencyId,
      incidentId,
      priorityIndividual,
      incidentPriority,
      priority,
      score,
      reasonCodes,
      algorithmVersion,
    },
  };
}

module.exports = {
  buildEmergencyCreatedEvent,
  buildEmergencyUpdatedEvent,
  buildEmergencyPrioritizedEvent,
  STATUS_TO_ESTADO,
  SEVERITY_TO_PRIORIDAD,
};
