const { randomUUID } = require('crypto');
const { ValidationError } = require('../../../errors/app-errors');
const { CONTEXTO_TIPO, ORIGEN_ESPACIOS } = require('../../../domain/contexto-zona');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyCreatedEvent } = require('../../../services/emergency-events');
const { severityForType } = require('../../../domain/severity');
const { correlationIdExterno } = require('../../../domain/correlation-id');

const PROGRAMAR_COBERTURA = 'ProgramarCobertura';
const CAUSA_TIPO = 'EVENTO_PUBLICO';
// Causas que puede pedir la regla: EVENTO_PUBLICO (evento comunitario, default)
// o RESERVA (reserva grande de un espacio, ReservaCreada).
const CAUSAS_PERMITIDAS = new Set([CAUSA_TIPO, 'RESERVA']);
const EMERGENCY_TYPE = 'PREVENTIVA';
const MAX_DESCRIPTION_LENGTH = 200;

// Mismo topic que el alta del botón de pánico: la cobertura sale como
// cualquier EmergenciaCreada.
function emergenciaCreadaTopic() {
  return process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico';
}

// Contexto de zona del evento comunitario (uno por eventoId). Dado de baja es
// la marca de que Espacios canceló el evento: la deja DarDeBajaContextoZona
// (regla 02 de EventoCancelado) en la misma transacción que CancelarCobertura,
// aunque todavía no exista ni la cobertura ni el contexto.
function contextoDelEvento(eventoId) {
  return { tipo: CONTEXTO_TIPO.EVENTO_ESPACIO_PUBLICO, origen: ORIGEN_ESPACIOS, referenciaBase: eventoId };
}

// Publicación (o ActividadCreada) y cancelación llegan por tópicos distintos y
// el consumer procesa varias particiones a la vez (issue #88). Las dos
// transacciones toman el mismo advisory lock antes de mirar la cobertura: la
// cancelación ve la cobertura ya creada, o la publicación ve la marca de
// baja. Es el mismo esquema que la alerta climática.
function bloquearEvento(contextoZonaRepository, client, eventoId) {
  return contextoZonaRepository.bloquearGrupo(client, contextoDelEvento(eventoId));
}

// Crea una emergencia PREVENTIVA de origen externo para un evento comunitario
// o una reserva de espacio de Espacios que superó el umbral de personas.
// `eventoId` es el id de la causa (eventoId o reservaId) y `causaTipo` dice
// cuál (default EVENTO_PUBLICO).
//
// Corre dentro de la transacción del OutcomeFactory (recibe `client`) y pasa
// por el repositorio, igual que un alta normal: INSERT + EmergenciaCreada en
// el outbox. Espacios republica EventoComunitarioPublicado cada vez que
// cambian los inscriptos, así que hay una sola cobertura por eventoId (lo
// garantiza también el índice único de V23).
//
// Un evento comunitario que ya se canceló (la cancelación llegó antes) no
// programa nada. Una RESERVA no tiene cancelación que la frene.
//
// Sin ubicación queda requires_manual_validation=true para que el dispatcher
// la revise. El correlationId de Espacios (evento-<id>, act-<id>) se conserva
// aunque no sea UUID (correlationIdExterno); si no viene o no sirve, en ese
// caso la emergencia usa el propio id y el vínculo queda en causaId.
function createProgramarCoberturaHandler({
  emergencyRepository,
  contextoZonaRepository,
  topic = emergenciaCreadaTopic(),
}) {
  if (!emergencyRepository) throw new Error('createProgramarCoberturaHandler requiere emergencyRepository');
  if (!contextoZonaRepository) throw new Error('createProgramarCoberturaHandler requiere contextoZonaRepository');

  return async function programarCobertura(client, payload) {
    const { eventoId, titulo, latitud, longitud, direccion, barrio, capacidad, correlationId } = payload || {};
    if (!eventoId) throw new ValidationError('ProgramarCobertura requiere eventoId');
    const causaTipo = payload.causaTipo ?? CAUSA_TIPO;
    if (!CAUSAS_PERMITIDAS.has(causaTipo)) {
      throw new ValidationError(`ProgramarCobertura no admite causaTipo ${causaTipo}`);
    }

    if (causaTipo === CAUSA_TIPO) {
      await bloquearEvento(contextoZonaRepository, client, eventoId);
      if (await contextoZonaRepository.grupoDadoDeBaja(client, contextoDelEvento(eventoId))) {
        secureLog('info', 'Evento comunitario ya cancelado: no se programa cobertura', { eventoId });
        return { emergencyId: null, created: false, cancelado: true };
      }
    }

    const existing = await emergencyRepository.findByCausa(client, {
      causaTipo,
      causaId: eventoId,
      emergencyType: EMERGENCY_TYPE,
    });
    if (existing.length > 0) {
      secureLog('info', 'Cobertura preventiva ya programada', { eventoId, causaTipo, emergencyId: existing[0].id });
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
      correlationId: correlationIdExterno(correlationId) ?? emergencyId,
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
      causaTipo,
      causaId: eventoId,
      outboxEvent: {
        topic,
        payload: (savedEmergency, eventId) => buildEmergencyCreatedEvent(savedEmergency, eventId),
      },
    });

    secureLog('info', 'Cobertura preventiva programada', {
      emergencyId,
      eventoId,
      causaTipo,
      requiresManual: !hasLocation,
    });

    return { emergencyId, created: true };
  };
}

module.exports = {
  PROGRAMAR_COBERTURA,
  CAUSA_TIPO,
  EMERGENCY_TYPE,
  bloquearEvento,
  createProgramarCoberturaHandler,
};
