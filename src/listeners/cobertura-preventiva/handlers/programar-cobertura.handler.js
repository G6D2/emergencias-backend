const { randomUUID } = require('crypto');
const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyCreatedEvent } = require('../../../services/emergency-events');
const { severityForType } = require('../../../domain/severity');

const PROGRAMAR_COBERTURA = 'ProgramarCobertura';
const CAUSA_TIPO = 'EVENTO_PUBLICO';
const EMERGENCY_TYPE = 'PREVENTIVA';
const MAX_DESCRIPTION_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mismo topic que el alta del botón de pánico: la cobertura sale como
// cualquier EmergenciaCreada.
function emergenciaCreadaTopic() {
  return process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico';
}

// Crea una emergencia PREVENTIVA de origen externo para un evento comunitario
// de Espacios que superó el umbral de capacidad.
//
// Corre dentro de la transacción del OutcomeFactory (recibe `client`) y pasa
// por el repositorio, igual que un alta normal: INSERT + EmergenciaCreada en
// el outbox. Espacios republica EventoComunitarioPublicado cada vez que
// cambian los inscriptos, así que hay una sola cobertura por eventoId (lo
// garantiza también el índice único de V23).
//
// Sin ubicación queda requires_manual_validation=true para que el dispatcher
// la revise. El correlationId de Espacios (evento-<id>) no es un UUID; en ese
// caso la emergencia usa el propio id y el vínculo queda en causaId.
function createProgramarCoberturaHandler({ emergencyRepository, topic = emergenciaCreadaTopic() }) {
  if (!emergencyRepository) throw new Error('createProgramarCoberturaHandler requiere emergencyRepository');

  return async function programarCobertura(client, payload) {
    const { eventoId, titulo, latitud, longitud, direccion, barrio, capacidad, correlationId } = payload || {};
    if (!eventoId) throw new ValidationError('ProgramarCobertura requiere eventoId');

    const existing = await emergencyRepository.findByCausa(client, {
      causaTipo: CAUSA_TIPO,
      causaId: eventoId,
      emergencyType: EMERGENCY_TYPE,
    });
    if (existing.length > 0) {
      secureLog('info', 'Cobertura preventiva ya programada', { eventoId, emergencyId: existing[0].id });
      return { emergencyId: existing[0].id, created: false };
    }

    const hasLocation = Number.isFinite(latitud) && Number.isFinite(longitud);
    const nombre = titulo || 'Evento comunitario';
    const description = (capacidad != null
      ? `Cobertura preventiva — ${nombre} (${capacidad} asistentes esperados)`
      : `Cobertura preventiva — ${nombre}`).slice(0, MAX_DESCRIPTION_LENGTH);
    const emergencyId = randomUUID();

    // Barrio: el repository deriva por PIP si hay coords; si no, usa el texto
    // solo cuando coincide con el catálogo oficial de CABA.
    await emergencyRepository.create({
      client,
      id: emergencyId,
      correlationId: UUID_PATTERN.test(correlationId || '') ? correlationId : emergencyId,
      userId: null,
      latitude: hasLocation ? latitud : null,
      longitude: hasLocation ? longitud : null,
      address: typeof direccion === 'string' ? direccion : null,
      barrioText: typeof barrio === 'string' ? barrio : null,
      description,
      severity: severityForType(EMERGENCY_TYPE),
      emergencyType: EMERGENCY_TYPE,
      status: 'PENDING',
      source: 'EXTERNAL',
      requiresManualValidation: !hasLocation,
      causaTipo: CAUSA_TIPO,
      causaId: eventoId,
      outboxEvent: {
        topic,
        payload: (savedEmergency, eventId) => buildEmergencyCreatedEvent(savedEmergency, eventId),
      },
    });

    secureLog('info', 'Cobertura preventiva programada', {
      emergencyId,
      eventoId,
      requiresManual: !hasLocation,
    });

    return { emergencyId, created: true };
  };
}

module.exports = { PROGRAMAR_COBERTURA, CAUSA_TIPO, EMERGENCY_TYPE, createProgramarCoberturaHandler };
