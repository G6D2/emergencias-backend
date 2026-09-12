function emergencyData(emergency) {
  const {
    id,
    correlationId,
    userId,
    description,
    severity,
    status,
    assignedOfficerId,
    emergencyType,
    createdAt,
    updatedAt,
  } = emergency;

  return {
    id,
    correlationId: correlationId || id,
    userId,
    description,
    severity,
    status,
    assignedOfficerId,
    emergencyType,
    createdAt,
    updatedAt,
  };
}

// correlationId = emergencyId al crear (tarea #58, ADR-001). Se lee de la
// columna propia; el fallback al id cubre filas anteriores a V9.
function buildEmergencyCreatedEvent(emergency, eventId) {
  return {
    type: 'EmergenciaCreada',
    eventId,
    correlationId: emergency.correlationId || emergency.id,
    data: emergencyData(emergency),
  };
}

function buildEmergencyStatusUpdatedEvent({ emergency, history, actor, reason, eventId }) {
  return {
    type: 'EmergenciaEstadoActualizado',
    eventId,
    correlationId: emergency.correlationId || emergency.id,
    data: {
      id: emergency.id,
      correlationId: emergency.correlationId || emergency.id,
      previousStatus: history.previousStatus,
      newStatus: history.newStatus,
      actor,
      reason: reason ?? null,
      timestamp: new Date().toISOString(),
    },
  };
}

function buildEmergencyClosedEvent({ emergency, actor, eventId }) {
  return {
    type: 'EmergenciaCerrada',
    eventId,
    correlationId: emergency.correlationId || emergency.id,
    data: {
      id: emergency.id,
      correlationId: emergency.correlationId || emergency.id,
      actor,
      closedAt: emergency.closedAt,
    },
  };
}

module.exports = {
  buildEmergencyCreatedEvent,
  buildEmergencyStatusUpdatedEvent,
  buildEmergencyClosedEvent,
};