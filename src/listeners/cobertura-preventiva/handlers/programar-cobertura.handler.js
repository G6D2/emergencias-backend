const { randomUUID } = require('crypto');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyCreatedEvent } = require('../../../services/emergency-events');

const PROGRAMAR_COBERTURA = 'ProgramarCobertura';

// Crea una emergencia PENDIENTE de origen externo en respuesta a un
// EventoComunitarioPublicado que supero el umbral de capacidad.
//
// Corre dentro de la transaccion de OutcomeFactory (recibe `client` por
// argumento). Si la transaccion hace ROLLBACK, el INSERT se revierte.
//
// correlation_id = causationEventId: LiberarCoberturaPreventiva (EventoCancelado)
// lo usa como clave para cerrar esta emergencia si llega la cancelacion.
// Si lat/lng faltan, requires_manual_validation=true para que el dispatcher
// la revise. severity='low': cobertura preventiva no es urgente.
function createProgramarCoberturaHandler({ locationCrypto, emergencyRepository, topic, userIdForExternal = 'eda-bus' }) {
  if (!locationCrypto) throw new Error('createProgramarCoberturaHandler requiere locationCrypto');
  if (!emergencyRepository) throw new Error('createProgramarCoberturaHandler requiere emergencyRepository');
  if (!topic) throw new Error('createProgramarCoberturaHandler requiere topic');

  return async function programarCobertura(client, payload) {
    const { nombre, latitud, longitud, capacidad, causationEventId } = payload || {};
    if (!causationEventId) throw new Error('ProgramarCobertura requiere causationEventId en el payload');

    const requiresManual = latitud === null || latitud === undefined || longitud === null || longitud === undefined;
    const locationEncrypted = requiresManual
      ? null
      : locationCrypto.encryptLocation({ latitude: latitud, longitude: longitud, address: nombre });

    const description = capacidad != null
      ? `Cobertura preventiva — ${nombre} (${capacidad} asistentes esperados)`
      : `Cobertura preventiva — ${nombre}`;

    const emergencyId = randomUUID();
    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO emergencies
         (id, correlation_id, user_id, location_encrypted, description,
          severity, emergency_type, status, source, requires_manual_validation)
       VALUES ($1, $2, $3, $4, $5, 'low', 'DISTURBIO_EVENTO_MASIVO', 'PENDING', 'EXTERNAL', $6)`,
      [emergencyId, causationEventId, userIdForExternal, locationEncrypted, description, requiresManual]
    );

    // Cola el EmergenciaCreada en el outbox dentro de la misma tx, igual que el
    // flujo del boton de panico (issue #65: "creacion via el mismo flujo del outbox").
    await emergencyRepository.insertOutboxEvent(client, {
      topic,
      payload: (_entity, eventId) => buildEmergencyCreatedEvent(
        {
          id: emergencyId,
          correlationId: causationEventId,
          userId: userIdForExternal,
          emergencyType: 'DISTURBIO_EVENTO_MASIVO',
          severity: 'low',
          status: 'PENDING',
          createdAt: now,
        },
        eventId
      ),
    }, { id: emergencyId });

    secureLog('info', 'Cobertura preventiva programada', {
      emergencyId,
      causationEventId,
      requiresManual,
    });

    return { emergencyId, requiresManual };
  };
}

module.exports = { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler };
