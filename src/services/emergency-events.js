// Contrato cerrado por Juani en issue #48 (comment 6589800911, 2026-11-02).
// Reemplaza los criterios originales del issue; refleja lo que leen reclamos,
// espacios, movilidad, residuos y analitica + lo acordado con Analitica el
// 29/10. La traduccion se hace solo al armar el evento: la base no cambia.

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

function buildEmergencyCreatedEvent(emergency, eventId) {
  const correlationId = emergency.correlationId || emergency.id;
  return {
    type: 'EmergenciaCreada',
    eventId,
    correlationId,
    data: {
      emergenciaId: emergency.id,
      categoria: emergency.emergencyType ?? null,
      prioridad: toPrioridad(emergency.severity),
      estado: toEstado(emergency.status),
      // #76: hasta que el ingreso resuelva barrio desde lat/lng va null.
      // Plano para Reclamos y Analitica (contrato del #48); anidado para
      // Espacios, que lo lee en data.ubicacion.barrio.
      barrio: emergency.barrio ?? null,
      ubicacion: { barrio: emergency.barrio ?? null },
      afectaCirculacion: toAfectaCirculacion(emergency.emergencyType),
      // Opcionales con default null: la regla de cuando poblarlos la cierra
      // Juani con Valentina (ver memoria project-decision-latlng-bus).
      latitud: null,
      longitud: null,
      // Causa externa (convencion de Analitica). Hoy la completa la cobertura
      // preventiva (EVENTO_PUBLICO); el resto de las causas llega con #77/#79/#80.
      causaId: emergency.causaId ?? null,
      causaTipo: emergency.causaTipo ?? null,
      // Hasta #79/#85 publicamos null; obligatorio solo si causaTipo=EVENTO_CLIMATICO.
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
      // resueltoAt solo en transicion a RESUELTA.
      resueltoAt: estadoNuevo === 'RESUELTA' ? (emergency.resolvedAt || new Date().toISOString()) : null,
      usuarioId: actor ?? null,
      // En DESPACHADA, hoy publicamos un unico evento con el oficial asignado.
      // #85: si un despacho asigna N recursos, generar N eventos (uno por recurso).
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
