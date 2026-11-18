const { randomUUID } = require('crypto');
const { ValidationError } = require('../../../errors/app-errors');
const { secureLog } = require('../../../security/secure-log');
const { buildEmergencyCreatedEvent } = require('../../../services/emergency-events');
const { severityForType } = require('../../../domain/severity');
const { correlationIdExterno } = require('../../../domain/correlation-id');

const CREAR_INTERVENCION = 'CrearIntervencionPorReclamo';
const CAUSA_TIPO = 'RECLAMO';
const EMERGENCY_TYPE = 'TRANSITO';
const MAX_DESCRIPTION_LENGTH = 200;

// Índice único de V29: una sola emergencia con causa RECLAMO por reclamo.
const UNIQUE_VIOLATION = '23505';
const UQ_RECLAMO_CAUSA = 'uq_emergencies_reclamo_causa';
const SAVEPOINT = 'crear_intervencion_por_reclamo';

// La prioridad la clasifica Reclamos (Movilidad la reenvía tal cual); si no
// viene o no la conocemos, vale la del tipo.
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

function esIntervencionDuplicada(error) {
  return Boolean(error) && error.code === UNIQUE_VIOLATION && error.constraint === UQ_RECLAMO_CAUSA;
}

// Lo disparan dos reglas: la de EmergenciaSolicitada (Movilidad) y la de
// ReclamoCreado (Reclamos), según RECLAMO_INTERVENCION_DISPARADOR.
function createCrearIntervencionHandler({ emergencyRepository, topic = emergenciaCreadaTopic() }) {
  if (!emergencyRepository) throw new Error('createCrearIntervencionHandler requiere emergencyRepository');

  return async function crearIntervencion(client, payload) {
    const { reclamoId, titulo, prioridad, latitud, longitud, direccion, barrio, correlationId } = payload || {};
    if (!reclamoId) throw new ValidationError('CrearIntervencionPorReclamo requiere reclamoId');

    const causa = { causaTipo: CAUSA_TIPO, causaId: reclamoId };
    const existing = await emergencyRepository.findByCausa(client, causa);
    if (existing.length > 0) {
      secureLog('info', 'Intervención por reclamo ya creada', { reclamoId, emergencyId: existing[0].id });
      return { emergencyId: existing[0].id, created: false };
    }

    const hasLocation = Number.isFinite(latitud) && Number.isFinite(longitud);
    const description = (titulo
      ? `Reclamo por ciclovía obstruida — ${titulo}`
      : 'Reclamo por ciclovía obstruida').slice(0, MAX_DESCRIPTION_LENGTH);
    const emergencyId = randomUUID();

    // Los topics se procesan en paralelo (un solo consumer y un solo group,
    // pero varias particiones a la vez; ver EventConsumer): dos eventos del
    // mismo reclamo pueden pasar el findByCausa sin ver nada (no hay fila que
    // bloquear) y el segundo INSERT choca con el índice único.
    // Un INSERT fallido deja abortada la transacción del OutcomeFactory; el
    // SAVEPOINT permite deshacer solo eso y terminar como "ya creada", con el
    // evento registrado como procesado en vez de descartado.
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      await emergencyRepository.create({
        client,
        id: emergencyId,
        // El correlationId de Movilidad o Reclamos se conserva aunque no sea
        // UUID; si no viene o no sirve, el id propio. El reclamoId siempre
        // queda asociado por causaTipo/causaId.
        correlationId: correlationIdExterno(correlationId) ?? emergencyId,
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
    } catch (error) {
      if (!esIntervencionDuplicada(error)) throw error;
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      const [ganadora] = await emergencyRepository.findByCausa(client, causa);
      if (!ganadora) {
        // Postgres avisa el choque recién cuando la otra transacción confirmó,
        // así que con READ COMMITTED la fila ya se ve. Si no aparece, la
        // reentrega arranca con otra foto de la base y la encuentra.
        error.transient = true;
        throw error;
      }
      secureLog('info', 'Intervención por reclamo ya creada por otro evento en paralelo', {
        reclamoId,
        emergencyId: ganadora.id,
      });
      return { emergencyId: ganadora.id, created: false };
    }
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);

    secureLog('info', 'Intervención por reclamo creada', { emergencyId, reclamoId, requiresManual: !hasLocation });
    return { emergencyId, created: true };
  };
}

module.exports = { CREAR_INTERVENCION, CAUSA_TIPO, EMERGENCY_TYPE, createCrearIntervencionHandler };
