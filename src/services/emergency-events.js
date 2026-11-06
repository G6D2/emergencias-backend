// Contrato cerrado por Juani en issue #48 (comment 6589800911, 2026-11-02).
// Reemplaza los criterios originales del issue; refleja lo que leen reclamos,
// espacios, movilidad, residuos y analitica + lo acordado con Analitica el
// 29/10. La traduccion se hace solo al armar el evento: la base no cambia.
//
// Extensión: ubicacion.latitud/longitud van cifrados con BUS_LOCATION_ENCRYPTION_KEY
// (solo anidados; no hay latitud/longitud en la raíz de data).

const { getBusLocationCrypto } = require('../security/bus-location-crypto');
const { secureLog } = require('../security/secure-log');

// Tipos que cortan la circulación (decisión Juani 2026-11-05).
// TRANSITO: pendiente de agregar al catálogo (migration + emergency-type.js).
// RECLAMO: cuando llegue el listener de ReclamoCreado, usar el afectaCirculacion
// que manda Reclamos en lugar de derivarlo por categoría.
const AFECTA_CIRCULACION = new Set([
  'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO', 'PREVENTIVA',
]);

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

function toAfectaCirculacion(emergencyType) {
  if (!emergencyType) return null;
  return AFECTA_CIRCULACION.has(emergencyType);
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
    const emergencyId = emergency.id;
    return {
      latitud: busCrypto.encryptCoordinate(lat, { emergencyId, field: 'latitud' }),
      longitud: busCrypto.encryptCoordinate(lng, { emergencyId, field: 'longitud' }),
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
      // Plano (catálogo / Reclamos-Analítica) + anidado (Espacios y coords cifradas).
      barrio: emergency.barrio ?? null,
      ubicacion: {
        barrio: emergency.barrio ?? null,
        latitud: encrypted.latitud,
        longitud: encrypted.longitud,
      },
      afectaCirculacion: toAfectaCirculacion(emergency.emergencyType),
      // Causa externa (convencion de Analitica). Hoy la completa la cobertura
      // preventiva (EVENTO_PUBLICO); el resto de las causas llega con #77/#79/#80.
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
