// Contrato cerrado por Juani en issue #48 (comment 6589800911, 2026-11-02).
// Reemplaza los criterios originales del issue; refleja lo que leen reclamos,
// espacios, movilidad, residuos y analitica + lo acordado con Analitica el
// 29/10. La traduccion se hace solo al armar el evento: la base no cambia.
//
// Ubicación en el bus (decisión Juani 2026-11-12):
// - data.latitud / data.longitud: número en claro, redondeado a 3 decimales
//   (~100 m). Es lo que leen Movilidad, Residuos, Reclamos, Espacios y
//   Analítica; ninguno descifra. Ubica la cuadra, no el domicilio.
// - data.ubicacion.latitud / longitud: la coordenada exacta, cifrada con
//   BUS_LOCATION_ENCRYPTION_KEY (para quien tenga la clave).
// La retención pone las cuatro en null en los payloads guardados en el outbox
// (EmergencyRepository.scrubOutboxBusCoordinates): un campo de ubicación nuevo
// en estos eventos tiene que sumarse ahí.

const { getBusLocationCrypto } = require('../security/bus-location-crypto');
const { secureLog } = require('../security/secure-log');

// Tipos que cortan la circulación (decisión Juani 2026-11-05).
// TRANSITO nace de un reclamo de tránsito (listener reclamo-intervencion), que
// Reclamos siempre publica con afectaCirculacion = true: derivarlo del tipo da
// el mismo valor.
const AFECTA_CIRCULACION = new Set([
  'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO', 'PREVENTIVA', 'TRANSITO',
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

const COORD_DECIMALS = 3;

function roundCoord(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

// Las dos o ninguna: un par incompleto no ubica nada.
function approximateCoords(emergency) {
  const latitud = roundCoord(emergency.latitude);
  const longitud = roundCoord(emergency.longitude);
  if (latitud === null || longitud === null) return { latitud: null, longitud: null };
  return { latitud, longitud };
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
  const approx = approximateCoords(emergency);

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
      latitud: approx.latitud,
      longitud: approx.longitud,
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

function buildEmergencyUpdatedEvent({ emergency, history, actor, reason, eventId }, options = {}) {
  const correlationId = emergency.correlationId || emergency.id;
  const estadoNuevo = toEstado(history.newStatus);
  const busCrypto = options.busCrypto !== undefined
    ? options.busCrypto
    : getBusLocationCrypto();
  const encrypted = encryptBusCoords(emergency, busCrypto);
  const approx = approximateCoords(emergency);
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
      causasRelacionadas: emergency.causasRelacionadas ?? [],
      descripcionProblema: emergency.descripcionProblema ?? null,
      barrio: emergency.barrio ?? null,
      latitud: approx.latitud,
      longitud: approx.longitud,
      ubicacion: {
        barrio: emergency.barrio ?? null,
        latitud: encrypted.latitud,
        longitud: encrypted.longitud,
      },
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

// EmergenciaVinculadaAContextoZona (ADR "Publicar el vínculo de una
// emergencia con un contexto de zona"): un evento por fila de
// emergencia_contexto_zona, encolado en la misma sentencia que la fila (ver
// EmergencyRepository.linkZoneContexts). Clave de deduplicación para los
// consumidores: (emergenciaId, contextoId). No lleva coordenadas.
const ZONE_CONTEXT_LINK_EVENT_TYPE = 'EmergenciaVinculadaAContextoZona';
// Sube si cambia la forma de decidir el vínculo (radio, vigencia, exclusiones),
// para que los consumidores distingan vínculos viejos de nuevos.
const ZONE_CONTEXT_LINK_RULE_VERSION = 1;
// Categorías cuyos vínculos no salen al bus. Hoy ninguna: el ADR de
// coordenadas aproximadas se aceptó con 3 decimales (~100 m) para todas las
// categorías, PANICO incluida, así que un vínculo de 500 m no da más precisión
// que la coordenada. Si esa precisión bajara para una categoría, se suma acá.
const CATEGORIES_WITHOUT_PUBLISHED_LINK = new Set();

function zoneContextLinkTopic(env = process.env) {
  return env.TOPIC_EMERGENCIA_VINCULADA_CONTEXTO || 'emergencias.vinculada-contexto-zona';
}

// El encolado queda apagado hasta que el tipo esté registrado en el catálogo
// del gateway; al encenderlo se corre el backfill (npm run backfill:vinculos-contexto).
function zoneContextLinkEventEnabled(env = process.env) {
  return env.EVENTO_VINCULO_CONTEXTO_ENABLED === 'true';
}

function shouldPublishZoneContextLink(emergencyType, env = process.env) {
  return zoneContextLinkEventEnabled(env) && !CATEGORIES_WITHOUT_PUBLISHED_LINK.has(emergencyType);
}

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildEmergencyLinkedToZoneContextEvent({
  emergencyId,
  correlationId,
  contexto,
  vinculadaEn,
  backfill = false,
  eventId,
}) {
  return {
    type: ZONE_CONTEXT_LINK_EVENT_TYPE,
    eventId,
    correlationId: correlationId || emergencyId,
    data: {
      emergenciaId: emergencyId,
      contextoId: contexto.id,
      contextoTipo: contexto.tipo,
      contextoOrigen: contexto.origen ?? null,
      referenciaExterna: contexto.referenciaExterna ?? null,
      radioMetros: Number(contexto.radioMetros),
      vinculadaEn: toIsoString(vinculadaEn),
      reglaVersion: ZONE_CONTEXT_LINK_RULE_VERSION,
      backfill: Boolean(backfill),
    },
  };
}

module.exports = {
  buildEmergencyCreatedEvent,
  buildEmergencyUpdatedEvent,
  buildEmergencyPrioritizedEvent,
  buildEmergencyLinkedToZoneContextEvent,
  shouldPublishZoneContextLink,
  zoneContextLinkEventEnabled,
  zoneContextLinkTopic,
  ZONE_CONTEXT_LINK_EVENT_TYPE,
  ZONE_CONTEXT_LINK_RULE_VERSION,
  CATEGORIES_WITHOUT_PUBLISHED_LINK,
  STATUS_TO_ESTADO,
  SEVERITY_TO_PRIORIDAD,
  COORD_DECIMALS,
};
