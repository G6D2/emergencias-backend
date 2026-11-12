const { randomUUID } = require('crypto');
const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyCreatedEvent } = require('../../../services/emergency-events');
const { severityForType } = require('../../../domain/severity');

const CREAR_INTERVENCION = 'CrearIntervencionPorReclamo';
const CAUSA_TIPO = 'RECLAMO';
const EMERGENCY_TYPE = 'TRANSITO';
const MAX_DESCRIPTION_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// La prioridad la clasifica Reclamos; si no viene o no la conocemos, vale la
// del tipo.
const PRIORIDAD_TO_SEVERITY = Object.freeze({
  BAJA: 'low',
  MEDIA: 'medium',
  ALTA: 'high',
  CRITICA: 'critical',
});

function emergenciaCreadaTopic() {
  return process.env.TOPIC_PANIC_BUTTON || 'emergencias.boton-panico';
}

function severityFor(prioridad) {
  const key = typeof prioridad === 'string' ? prioridad.trim().toUpperCase() : '';
  return PRIORIDAD_TO_SEVERITY[key] || severityForType(EMERGENCY_TYPE);
}

function createCrearIntervencionHandler({ emergencyRepository, topic = emergenciaCreadaTopic() }) {
  if (!emergencyRepository) throw new Error('createCrearIntervencionHandler requiere emergencyRepository');

  return async function crearIntervencion(client, payload) {
    const { reclamoId, titulo, prioridad, latitud, longitud, direccion, barrio, correlationId } = payload || {};
    if (!reclamoId) throw new ValidationError('CrearIntervencionPorReclamo requiere reclamoId');

    const existing = await emergencyRepository.findByCausa(client, { causaTipo: CAUSA_TIPO, causaId: reclamoId });
    if (existing.length > 0) {
      secureLog('info', 'Intervención por reclamo ya creada', { reclamoId, emergencyId: existing[0].id });
      return { emergencyId: existing[0].id, created: false };
    }

    const hasLocation = Number.isFinite(latitud) && Number.isFinite(longitud);
    const description = (titulo
      ? `Reclamo por ciclovía obstruida — ${titulo}`
      : 'Reclamo por ciclovía obstruida').slice(0, MAX_DESCRIPTION_LENGTH);
    const emergencyId = randomUUID();

    await emergencyRepository.create({
      client,
      id: emergencyId,
      // Reclamos manda un UUID salvo que el cliente haya puesto su propio
      // X-Correlation-Id: ese no entra en la columna y se usa el id propio.
      correlationId: UUID_PATTERN.test(correlationId || '') ? correlationId : emergencyId,
      userId: null,
      latitude: hasLocation ? latitud : null,
      longitude: hasLocation ? longitud : null,
      address: typeof direccion === 'string' ? direccion : null,
      barrioText: typeof barrio === 'string' ? barrio : null,
      description,
      severity: severityFor(prioridad),
      emergencyType: EMERGENCY_TYPE,
      status: 'PENDING',
      source: 'EXTERNAL',
      requiresManualValidation: !hasLocation,
      causaTipo: CAUSA_TIPO,
      causaId: reclamoId,
      outboxEvent: {
        topic,
        payload: (savedEmergency, eventId) => buildEmergencyCreatedEvent(savedEmergency, eventId),
      },
    });

    secureLog('info', 'Intervención por reclamo creada', { emergencyId, reclamoId, requiresManual: !hasLocation });
    return { emergencyId, created: true };
  };
}

module.exports = { CREAR_INTERVENCION, CAUSA_TIPO, EMERGENCY_TYPE, createCrearIntervencionHandler };
