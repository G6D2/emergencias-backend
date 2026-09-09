function emergencyData(emergency) {
  const {
    id,
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

function buildEmergencyCreatedEvent(emergency, eventId) {
  return {
    type: 'EmergenciaCreada',
    eventId,
    correlationId: emergency.id,
    data: emergencyData(emergency),
  };
}

function buildEmergencyStatusUpdatedEvent({ emergency, history, actor, reason, eventId }) {
  return {
    type: 'EmergenciaEstadoActualizado',
    eventId,
    correlationId: emergency.id,
    data: {
      id: emergency.id,
      previousStatus: history.previousStatus,
      newStatus: history.newStatus,
      actor,
      reason: reason ?? null,
      timestamp: new Date().toISOString(),
    },
  };
}

module.exports = { buildEmergencyCreatedEvent, buildEmergencyStatusUpdatedEvent };