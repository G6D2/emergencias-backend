const { NotFoundError, ConflictError } = require('../errors/app-errors');
const {
  assertTransition, isTerminal, expirationTarget, TERMINAL_STATUSES, ACTIVE_STATUSES,
} = require('../domain/emergency-status');
const { assertEmergencyType } = require('../domain/emergency-type');
const { resolveBarrio } = require('../domain/barrio');
const { haversineDistanceMeters } = require('../domain/rule-based-grouper');
const { createLocationCrypto } = require('../security/location-crypto');
const { randomUUID } = require('crypto');
const { secureLog } = require('../security/secure-log');
const { mapOfficer } = require('./officer.repository');
const { effectivePriority, dispatchPriority } = require('../domain/severity');
const {
  buildEmergencyLinkedToZoneContextEvent,
  shouldPublishZoneContextLink,
  zoneContextLinkTopic,
  ZONE_CONTEXT_LINK_EVENT_TYPE,
} = require('../services/emergency-events');

// Momento del último cambio de estado de la emergencia `e`: la última entrada
// del historial, o la creación si nunca cambió.
const LAST_STATUS_CHANGE_SQL = `GREATEST(
           e.created_at,
           COALESCE(
             (SELECT max(h.created_at) FROM emergency_status_history h WHERE h.emergency_id = e.id),
             e.created_at
           )
         )`;

// Una cobertura preventiva se programa con días de anticipación. Mientras el
// evento que la originó no terminó, o terminó hace menos que el plazo, no
// expira aunque nadie la haya tocado: su reloj corre desde el fin del evento.
// `hoursParam` es el placeholder del plazo en horas ($1, $2...).
function pendingPreventiveCoverageSql(hoursParam) {
  return `EXISTS (
           SELECT 1 FROM contexto_zona c
           WHERE e.emergency_type = 'PREVENTIVA'
             AND e.causa_tipo = 'EVENTO_PUBLICO'
             AND c.tipo = 'EVENTO_ESPACIO_PUBLICO'
             AND c.referencia_externa = e.causa_id
             AND c.dado_de_baja_en IS NULL
             AND c.vigente_hasta > now() - (${hoursParam}::double precision * interval '1 hour')
         )`;
}

// Pasa filas de Postgres (snake_case) a objetos JS (camelCase) para que el
// detalle de las columnas no se filtre afuera del repository.
function mapEmergency(row, locationCrypto) {
  if (!row) return null;

  let latitude = null;
  let longitude = null;
  // Dirección legible (opcional): viaja dentro del mismo plaintext cifrado
  // que lat/lng (ver security/location-crypto.js), así hereda retención de
  // 72h, anonimización y saneo de filas indescifrables sin columna nueva.
  let address = null;
  let locationUnavailable = false;
  const locationAnonymized = Boolean(row.location_anonymized_at);

  if (!locationAnonymized && row.location_encrypted && locationCrypto) {
    try {
      const location = locationCrypto.decryptLocation(row.location_encrypted);
      latitude = location.latitude;
      longitude = location.longitude;
      address = location.address ?? null;
    } catch (error) {
      // Una fila cifrada con otra clave (p. ej. insertada desde un entorno
      // local contra la base compartida) no puede tumbar todo el listado:
      // se devuelve sin ubicación y se deja constancia para saneamiento.
      locationUnavailable = true;
      secureLog('warn', 'Location ciphertext could not be decrypted', {
        emergencyId: row.id,
        message: error.message,
      });
    }
  } else if (!locationAnonymized && row.latitude != null && row.longitude != null) {
    // Filas legacy (pre-V3) aún en claro hasta retención o re-escritura.
    latitude = Number(row.latitude);
    longitude = Number(row.longitude);
  }

  return {
    id: row.id,
    correlationId: row.correlation_id,
    userId: row.user_id,
    latitude,
    longitude,
    address,
    locationAnonymized,
    locationUnavailable,
    description: row.description,
    severity: row.severity,
    status: row.status,
    assignedOfficerId: row.assigned_officer_id,
    assignedOfficer: row.assigned_officer_name || null,
    incidentId: row.incident_id,
    emergencyType: row.emergency_type,
    source: row.source ?? 'INTERNAL',
    requiresManualValidation: Boolean(row.requires_manual_validation),
    causaTipo: row.causa_tipo ?? null,
    causaId: row.causa_id ?? null,
    causasRelacionadas: row.causas_relacionadas ?? [],
    descripcionProblema: row.descripcion_problema ?? null,
    // Catálogo oficial CABA en claro; no se borra con la retención de ubicación.
    barrio: row.barrio ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

// Solo se llama sobre filas de queries que hicieron LEFT JOIN a incidents
// (ver INCIDENT_JOIN_SQL más abajo): ahí sí vienen las columnas incident_*.
// row.incident_id es una columna propia de emergencies (existe siempre,
// joineada o no); si el JOIN no encontró nada, todas las incident_* quedan
// NULL y esta función devuelve null (la emergencia todavía no pertenece a
// ningún incidente).
function mapIncidentSummary(row) {
  if (!row.incident_id) return null;
  return {
    id: row.incident_id,
    priority: row.incident_priority,
    score: row.incident_score != null ? Number(row.incident_score) : null,
    reportCount: row.incident_report_count != null ? Number(row.incident_report_count) : 0,
    uniqueCitizens: row.incident_unique_citizens != null ? Number(row.incident_unique_citizens) : 0,
    reasonCodes: row.incident_reason_codes,
  };
}

// Fragmento de SELECT/JOIN reusado por findPage y findDetailById (las dos
// lecturas que exponen el resultado del motor de incidentes al dispatcher/
// ciudadano, tarea de visibilidad apilada sobre #36). El resto de los
// métodos del repository (create, updateStatus, assignOfficer, ...) sigue
// usando el SELECT simple de siempre: no necesitan este dato y no vale la
// pena pagar el JOIN + subqueries en cada mutación.
const INCIDENT_JOIN_SQL = `LEFT JOIN incidents i ON i.id = e.incident_id`;
const INCIDENT_SELECT_FIELDS = `
       i.priority AS incident_priority,
       i.score AS incident_score,
       i.reason_codes AS incident_reason_codes,
       (SELECT COUNT(*)::int FROM emergencies em2 WHERE em2.incident_id = e.incident_id) AS incident_report_count,
       (SELECT COUNT(DISTINCT em3.user_id)::int FROM emergencies em3 WHERE em3.incident_id = e.incident_id) AS incident_unique_citizens`;

// Contexto de zona que eleva la prioridad de la emergencia (ADR "Elevar
// temporalmente la prioridad con contextos de zona", tablas de V28 y V31).
//
// El vínculo emergencia–contexto se escribe una sola vez, al crear la
// emergencia (ver linkZoneContexts): acá solo se mira si el contexto
// vinculado sigue en curso. Mientras lo está, la prioridad de despacho sube
// un nivel; al vencer, suspenderse o darse de baja, la próxima lectura ya no
// lo trae y la prioridad vuelve sola.
//
// - Se evalúa contra now(): nada se guarda en emergencies.
// - Varios contextos vinculados suben un solo nivel (LIMIT 1; se muestra el
//   que vence último).
// - No aplica a emergencias terminales ni a las PREVENTIVA: la cobertura del
//   propio evento no es un llamado.
const ZONE_CONTEXT_EN_CURSO_SQL = `c.dado_de_baja_en IS NULL
           AND c.suspendido_en IS NULL
           AND c.vigente_desde <= now()
           AND c.vigente_hasta > now()`;
const ZONE_CONTEXT_JOIN_SQL = `LEFT JOIN LATERAL (
         SELECT c.tipo, c.latitud, c.longitud, c.radio_metros, c.origen, c.referencia_externa,
                c.descripcion, c.vigente_desde, c.vigente_hasta
         FROM emergencia_contexto_zona ecz
         JOIN contexto_zona c ON c.id = ecz.contexto_id
         WHERE ecz.emergency_id = e.id
           AND ${ZONE_CONTEXT_EN_CURSO_SQL}
           AND e.emergency_type IS DISTINCT FROM 'PREVENTIVA'
           AND e.status NOT IN (${TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')})
         ORDER BY c.vigente_hasta DESC
         LIMIT 1
       ) cz ON true`;
const ZONE_CONTEXT_SELECT_FIELDS = `
       cz.tipo AS contexto_tipo,
       cz.latitud AS contexto_latitud,
       cz.longitud AS contexto_longitud,
       cz.radio_metros AS contexto_radio_metros,
       cz.origen AS contexto_origen,
       cz.referencia_externa AS contexto_referencia_externa,
       cz.descripcion AS contexto_descripcion,
       cz.vigente_desde AS contexto_vigente_desde,
       cz.vigente_hasta AS contexto_vigente_hasta`;

function mapZoneContext(row) {
  if (!row.contexto_tipo) return null;
  return {
    tipo: row.contexto_tipo,
    latitud: row.contexto_latitud,
    longitud: row.contexto_longitud,
    radioMetros: row.contexto_radio_metros,
    origen: row.contexto_origen,
    referenciaExterna: row.contexto_referencia_externa,
    descripcion: row.contexto_descripcion ?? null,
    vigenteDesde: row.contexto_vigente_desde,
    vigenteHasta: row.contexto_vigente_hasta,
  };
}

// mapEmergency + incident: null|{...} + effectivePriority (máximo entre
// severity individual y incident.priority, ver src/domain/severity.js) +
// dispatchPriority (un nivel más si hay un contexto de zona vigente) y
// priorityContext: null|{...} con el motivo de la suba.
function mapEmergencyWithIncident(row, locationCrypto) {
  const emergency = mapEmergency(row, locationCrypto);
  if (!emergency) return null;
  const incident = mapIncidentSummary(row);
  const priorityContext = mapZoneContext(row);
  const priority = effectivePriority(emergency.severity, incident ? incident.priority : null);
  return {
    ...emergency,
    incident,
    effectivePriority: priority,
    dispatchPriority: dispatchPriority(priority, Boolean(priorityContext)),
    priorityContext,
  };
}

function mapHistoryEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    emergencyId: row.emergency_id,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapAccessAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    emergencyId: row.emergency_id,
    actorSub: row.actor_sub,
    action: row.action,
    createdAt: row.created_at,
  };
}

// INSERT compartido por las ramas de create() (sin/con outbox, con transacción
// propia o del caller). correlation_id cae en el propio id si no viene (tarea #58).
const INSERT_SQL = `INSERT INTO emergencies (
     id, correlation_id, user_id, latitude, longitude, location_encrypted,
     description, severity, emergency_type, status,
     source, requires_manual_validation, causa_tipo, causa_id, barrio
   )
   VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7, COALESCE($8, 'PENDING'), $9, $10, $11, $12, $13)
   RETURNING *`;

// Repository de persistencia de emergencies.
// No sabe nada de Kafka, controllers ni HTTP: solo SQL + cifrado de ubicación.
class EmergencyRepository {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.locationCrypto = options.locationCrypto || createLocationCrypto();
    // Inyectable para tests (EVENTO_VINCULO_CONTEXTO_ENABLED y topics).
    this.env = options.env || process.env;
  }

  // source/causa vienen de las emergencias que crea el listener de eventos
  // externos (ADR #25); el alta ciudadana usa los defaults. Si se pasa `client`,
  // el INSERT y el outbox corren en la transacción del caller (la del
  // OutcomeFactory) y no se abre una propia.
  async create({
    id, correlationId, userId, latitude, longitude, address, description, severity, emergencyType, status,
    source = 'INTERNAL', requiresManualValidation = false, causaTipo = null, causaId = null,
    barrioText = null, barrio: barrioOverride = undefined,
    outboxEvent = null, client: externalClient = null,
  }) {
    // Una emergencia externa puede llegar sin ubicación (queda para validación
    // manual): sin lat/lng no hay nada que cifrar.
    const hasLocation = latitude !== null && latitude !== undefined
      && longitude !== null && longitude !== undefined;
    const locationEncrypted = hasLocation
      ? this.locationCrypto.encryptLocation({ latitude, longitude, address })
      : null;
    // barrioOverride permite tests/backfill explícito; si no, se deriva:
    // coords → PIP; sin coords → texto solo si está en el catálogo CABA.
    const barrio = barrioOverride !== undefined
      ? barrioOverride
      : resolveBarrio({ latitude, longitude, barrioText });
    const insertValues = [
      id,
      correlationId || id,
      userId,
      locationEncrypted,
      description || null,
      severity || null,
      // Se normaliza también acá (defensa en profundidad, igual que el CHECK
      // de V10): un alias del front llega al INSERT ya como canónico.
      assertEmergencyType(emergencyType),
      status || null,
      source,
      Boolean(requiresManualValidation),
      causaTipo,
      causaId,
      barrio,
    ];

    if (externalClient) {
      const result = await externalClient.query(INSERT_SQL, insertValues);
      const emergency = mapEmergency(result.rows[0], this.locationCrypto);
      await this.linkZoneContexts(externalClient, emergency);
      if (outboxEvent) await this.insertOutboxEvent(externalClient, outboxEvent, emergency);
      return emergency;
    }

    if (!outboxEvent) {
      const result = await this.pool.query(INSERT_SQL, insertValues);
      const emergency = mapEmergency(result.rows[0], this.locationCrypto);
      await this.linkZoneContexts(this.pool, emergency);
      return emergency;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(INSERT_SQL, insertValues);
      const emergency = mapEmergency(result.rows[0], this.locationCrypto);
      await this.linkZoneContexts(client, emergency);
      await this.insertOutboxEvent(client, outboxEvent, emergency);
      await client.query('COMMIT');
      return emergency;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Vincula la emergencia recién creada con los contextos de zona en curso
  // que la alcanzan (a no más de radio_metros de su punto). Es el único
  // momento en que se mide la distancia: la coordenada está en memoria y no
  // hace falta guardarla en claro ni descifrar nada después. Solo se guardan
  // los ids.
  //
  // Consecuencia: una emergencia creada antes de que empiece el evento (o
  // antes de que llegue su publicación) no sube de prioridad.
  async linkZoneContexts(executor, emergency) {
    const { id, latitude, longitude, emergencyType } = emergency;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    if (emergencyType === 'PREVENTIVA') return [];

    const enCurso = await executor.query(
      `SELECT c.id, c.latitud, c.longitud, c.radio_metros, c.tipo, c.origen, c.referencia_externa
       FROM contexto_zona c
       WHERE ${ZONE_CONTEXT_EN_CURSO_SQL}
         AND c.latitud IS NOT NULL
         AND c.longitud IS NOT NULL
         AND c.radio_metros IS NOT NULL`
    );
    const alcanzan = enCurso.rows.filter((c) => haversineDistanceMeters(
      { latitude, longitude },
      { latitude: Number(c.latitud), longitude: Number(c.longitud) }
    ) <= Number(c.radio_metros));
    const contextoIds = alcanzan.map((c) => c.id);
    if (contextoIds.length === 0) return [];

    if (!shouldPublishZoneContextLink(emergencyType, this.env)) {
      await executor.query(
        `INSERT INTO emergencia_contexto_zona (emergency_id, contexto_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [id, contextoIds]
      );
      return contextoIds;
    }

    // Con el evento de vínculo encendido, la fila y su evento del outbox se
    // escriben en UNA sentencia: si el vínculo existe, el evento existe, aunque
    // el executor sea el pool y no una transacción. Solo se encola evento para
    // los vínculos que se insertaron de verdad (ON CONFLICT DO NOTHING no
    // devuelve fila), así que un reintento no duplica.
    const vinculadaEn = new Date();
    const events = alcanzan.map((c) => buildEmergencyLinkedToZoneContextEvent({
      emergencyId: id,
      correlationId: emergency.correlationId,
      contexto: {
        id: c.id,
        tipo: c.tipo,
        origen: c.origen,
        referenciaExterna: c.referencia_externa,
        radioMetros: c.radio_metros,
      },
      vinculadaEn,
      eventId: randomUUID(),
    }));
    await executor.query(
      `WITH nuevos AS (
         INSERT INTO emergencia_contexto_zona (emergency_id, contexto_id, created_at)
         SELECT $1, unnest($2::uuid[]), $3
         ON CONFLICT DO NOTHING
         RETURNING contexto_id
       )
       INSERT INTO outbox_events (id, topic, payload)
       SELECT ev.id, $4, ev.payload
       FROM unnest($5::uuid[], $6::uuid[], $7::jsonb[]) AS ev(contexto_id, id, payload)
       JOIN nuevos ON nuevos.contexto_id = ev.contexto_id`,
      [
        id,
        contextoIds,
        vinculadaEn,
        zoneContextLinkTopic(this.env),
        events.map((event) => event.data.contextoId),
        events.map((event) => event.eventId),
        events.map((event) => JSON.stringify(event)),
      ]
    );
    return contextoIds;
  }

  // Backfill del evento de vínculo (ADR "Publicar el vínculo de una emergencia
  // con un contexto de zona", punto 6): encola, con backfill: true, los
  // vínculos que siguen en la base y todavía no tienen evento en el outbox.
  // Idempotente: una segunda corrida no encuentra nada. Solo recupera lo que
  // la retención no borró (unlinkZoneContexts al anonimizar).
  async enqueueMissingZoneContextLinkEvents() {
    const candidates = await this.pool.query(
      `SELECT ecz.emergency_id, ecz.contexto_id, ecz.created_at,
              e.correlation_id, e.emergency_type,
              c.tipo, c.origen, c.referencia_externa, c.radio_metros
       FROM emergencia_contexto_zona ecz
       JOIN emergencies e ON e.id = ecz.emergency_id
       JOIN contexto_zona c ON c.id = ecz.contexto_id
       WHERE NOT EXISTS (
         SELECT 1 FROM outbox_events o
         WHERE o.payload->>'type' = $1
           AND o.payload->'data'->>'emergenciaId' = ecz.emergency_id::text
           AND o.payload->'data'->>'contextoId' = ecz.contexto_id::text
       )
       ORDER BY ecz.created_at`,
      [ZONE_CONTEXT_LINK_EVENT_TYPE]
    );

    const events = candidates.rows
      .filter((row) => shouldPublishZoneContextLink(row.emergency_type, this.env))
      .map((row) => buildEmergencyLinkedToZoneContextEvent({
        emergencyId: row.emergency_id,
        correlationId: row.correlation_id,
        contexto: {
          id: row.contexto_id,
          tipo: row.tipo,
          origen: row.origen,
          referenciaExterna: row.referencia_externa,
          radioMetros: row.radio_metros,
        },
        vinculadaEn: row.created_at,
        backfill: true,
        eventId: randomUUID(),
      }));
    if (events.length === 0) {
      return { enqueuedCount: 0, skippedCount: candidates.rows.length };
    }

    await this.pool.query(
      `INSERT INTO outbox_events (id, topic, payload)
       SELECT ev.id, $1, ev.payload
       FROM unnest($2::uuid[], $3::jsonb[]) AS ev(id, payload)`,
      [
        zoneContextLinkTopic(this.env),
        events.map((event) => event.eventId),
        events.map((event) => JSON.stringify(event)),
      ]
    );
    return {
      enqueuedCount: events.length,
      skippedCount: candidates.rows.length - events.length,
    };
  }

  async insertOutboxEvent(client, { topic, payload }, entity) {
    const eventId = randomUUID();
    const eventPayload = typeof payload === 'function'
      ? payload(entity, eventId)
      : { ...payload, eventId };
    await client.query(
      `INSERT INTO outbox_events (id, topic, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [eventId, topic, JSON.stringify(eventPayload)]
    );
  }

  async findById(id) {
    const result = await this.pool.query(
      `SELECT e.*, o.name AS assigned_officer_name
       FROM emergencies e
       LEFT JOIN officers o ON o.id = e.assigned_officer_id
       WHERE e.id = $1`,
      [id]
    );
    return mapEmergency(result.rows[0], this.locationCrypto);
  }

  async findHistoryByEmergencyId(emergencyId) {
    const result = await this.pool.query(
      'SELECT * FROM emergency_status_history WHERE emergency_id = $1 ORDER BY created_at ASC',
      [emergencyId]
    );
    return result.rows.map(mapHistoryEntry);
  }

  /**
   * Detalle de una emergencia (tarea #32, + incident/effectivePriority):
   * la emergencia (con su incidente y prioridad efectiva si pertenece a
   * alguno) más su historial de estados en orden cronológico. El historial
   * es una segunda query, no un JOIN, para no multiplicar la fila principal
   * por cada entrada. Devuelve null si la emergencia no existe.
   */
  async findDetailById(id) {
    const result = await this.pool.query(
      `SELECT e.*, o.name AS assigned_officer_name, ${INCIDENT_SELECT_FIELDS}, ${ZONE_CONTEXT_SELECT_FIELDS}
       FROM emergencies e
       LEFT JOIN officers o ON o.id = e.assigned_officer_id
       ${INCIDENT_JOIN_SQL}
       ${ZONE_CONTEXT_JOIN_SQL}
       WHERE e.id = $1`,
      [id]
    );
    const emergency = mapEmergencyWithIncident(result.rows[0], this.locationCrypto);
    if (!emergency) return null;

    const statusHistory = await this.findHistoryByEmergencyId(id);
    return { ...emergency, statusHistory };
  }

  async recordAccess({ emergencyId, actorSub, action }) {
    const result = await this.pool.query(
      `INSERT INTO emergency_access_audit (emergency_id, actor_sub, action)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [emergencyId, actorSub, action]
    );
    return mapAccessAudit(result.rows[0]);
  }

  /**
   * Borra ciphertext de ubicaciones cerradas hace más de retentionHours.
   * Solo aplica a emergencias con closed_at (lo setea toda transición a un
   * estado terminal: CLOSED, CANCELLED, DISCARDED); las abiertas se conservan.
   * Las filas siguen existiendo; lat/lng quedan null (minimización).
   * Si barrio aún es null, lo deriva del ciphertext/coords legacy ANTES de
   * borrar la ubicación (evita perder el dato agregado en el deploy).
   */
  async anonymizeExpiredLocations(retentionHours) {
    const hours = Number(retentionHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error('retentionHours must be a positive number');
    }

    const candidates = await this.pool.query(
      `SELECT id, latitude, longitude, location_encrypted, barrio
       FROM emergencies
       WHERE location_anonymized_at IS NULL
         AND closed_at IS NOT NULL
         AND (
           location_encrypted IS NOT NULL
           OR latitude IS NOT NULL
           OR longitude IS NOT NULL
         )
         AND closed_at < now() - ($1::double precision * interval '1 hour')`,
      [hours]
    );

    if (candidates.rows.length === 0) {
      return { anonymizedCount: 0, ids: [] };
    }

    const ids = [];
    for (const row of candidates.rows) {
      if (await this.anonymizeLocationRow(this.pool, row)) ids.push(row.id);
    }

    if (ids.length > 0) {
      await this.unlinkZoneContexts(ids);
      // El outbox conserva los payloads más allá de las 72 h (PUBLISHED hasta
      // su purga; SKIPPED, FAILED y PENDING sin plazo). Hay que scrubear ahí las
      // coords del bus: las cifradas, que si no quedan descifrables con la clave
      // compartida tras anonimizar at-rest, y las aproximadas en claro.
      await this.scrubOutboxBusCoordinates(ids);
    }

    return {
      anonymizedCount: ids.length,
      ids,
    };
  }

  /**
   * Borra la ubicación de una fila (id, latitude, longitude,
   * location_encrypted, barrio) con el executor dado: el pool, o el client de
   * una transacción en curso. Si barrio es null lo deriva de la ubicación antes
   * de borrarla. Devuelve true si la fila quedó anonimizada en esta llamada.
   */
  async anonymizeLocationRow(executor, row) {
    let barrio = row.barrio || null;
    if (!barrio) {
      let latitude = row.latitude != null ? Number(row.latitude) : null;
      let longitude = row.longitude != null ? Number(row.longitude) : null;
      if (row.location_encrypted) {
        try {
          const location = this.locationCrypto.decryptLocation(row.location_encrypted);
          latitude = location.latitude;
          longitude = location.longitude;
        } catch (error) {
          secureLog('warn', 'anonymizeExpiredLocations: ciphertext indescifrable; se anonimiza sin barrio', {
            emergencyId: row.id,
            message: error.message,
          });
        }
      }
      barrio = resolveBarrio({ latitude, longitude });
    }

    const result = await executor.query(
      `UPDATE emergencies
       SET location_encrypted = NULL,
           latitude = NULL,
           longitude = NULL,
           location_anonymized_at = now(),
           barrio = COALESCE(barrio, $2),
           updated_at = now()
       WHERE id = $1
         AND location_anonymized_at IS NULL
       RETURNING id`,
      [row.id, barrio]
    );
    return result.rowCount > 0;
  }

  /**
   * Expira las emergencias abiertas que llevan más de `hours` sin cambiar de
   * estado: las pasa al estado terminal de expirationTarget() (RESOLVED se
   * cierra, el resto se cancela) y anonimiza su ubicación en la misma
   * transacción. Así la regla de retención es una sola: la ubicación se
   * conserva `hours` desde el último cambio de estado, esté cerrada o no.
   *
   * El plazo se mide desde el último registro del historial (o desde la
   * creación si nunca cambió de estado), no desde updated_at, que también
   * mueven el job de incidentes y el backfill de barrios.
   *
   * Cada emergencia va en su propia transacción: una que falla no frena al
   * resto. FOR UPDATE SKIP LOCKED y la condición repetida adentro hacen que
   * dos instancias (o un endpoint en simultáneo) no la expiren dos veces.
   * El evento del outbox sale sin coordenadas, porque se arma después de
   * anonimizar; el barrio se conserva.
   */
  async expireStaleEmergencies(hours, {
    limit = 100, actor = null, reason = null, outboxEvent = null,
  } = {}) {
    const staleHours = Number(hours);
    if (!Number.isFinite(staleHours) || staleHours <= 0) {
      throw new Error('hours must be a positive number');
    }

    const candidates = await this.pool.query(
      `SELECT e.id
       FROM emergencies e
       WHERE e.status = ANY($2::text[])
         AND ${LAST_STATUS_CHANGE_SQL} < now() - ($1::double precision * interval '1 hour')
         AND NOT ${pendingPreventiveCoverageSql('$1')}
       ORDER BY e.created_at
       LIMIT $3`,
      [staleHours, ACTIVE_STATUSES, limit]
    );

    const expired = [];
    const anonymizedIds = [];
    let failed = 0;
    for (const { id } of candidates.rows) {
      try {
        const result = await this.expireOne(id, staleHours, { actor, reason, outboxEvent });
        if (!result) continue;
        expired.push({ id, previousStatus: result.previousStatus, newStatus: result.newStatus });
        if (result.anonymized) anonymizedIds.push(id);
      } catch (error) {
        failed += 1;
        secureLog('error', 'No se pudo expirar la emergencia', { emergencyId: id, message: error.message });
      }
    }

    if (anonymizedIds.length > 0) {
      await this.unlinkZoneContexts(anonymizedIds);
      await this.scrubOutboxBusCoordinates(anonymizedIds);
    }

    return { expiredCount: expired.length, failedCount: failed, expired };
  }

  // Devuelve null si la emergencia ya no cumple la condición (otro proceso la
  // cambió de estado o la tiene tomada).
  async expireOne(id, staleHours, { actor, reason, outboxEvent }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT e.id, e.status, e.latitude, e.longitude, e.location_encrypted, e.barrio,
                e.location_anonymized_at
         FROM emergencies e
         WHERE e.id = $1
           AND e.status = ANY($3::text[])
           AND ${LAST_STATUS_CHANGE_SQL} < now() - ($2::double precision * interval '1 hour')
           AND NOT ${pendingPreventiveCoverageSql('$2')}
         FOR UPDATE OF e SKIP LOCKED`,
        [id, staleHours, ACTIVE_STATUSES]
      );
      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = locked.rows[0];
      const hasLocation = row.location_encrypted !== null || row.latitude !== null || row.longitude !== null;
      const anonymized = hasLocation && row.location_anonymized_at === null
        ? await this.anonymizeLocationRow(client, row)
        : false;
      const newStatus = expirationTarget(row.status);
      await this.applyStatusUpdate(client, id, {
        newStatus, actor, reason, outboxEvent, expiration: true,
      });
      await client.query('COMMIT');
      return { previousStatus: row.status, newStatus, anonymized };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Pone en null las coordenadas de los payloads de outbox_events ligados a
   * esas emergencias (cualquier status). Conserva barrio. Son las dos formas
   * en que emergency-events.js publica la ubicación:
   * - data.ubicacion.latitud/longitud: la exacta, cifrada (string).
   * - data.latitud/longitud: la aproximada en claro (número, desde el #92).
   *   Con create_missing = false: a un payload anterior, que no trae esas
   *   claves en la raíz, no se le agregan.
   * El WHERE deja afuera las filas que no tienen nada para limpiar.
   */
  async scrubOutboxBusCoordinates(emergencyIds) {
    if (!Array.isArray(emergencyIds) || emergencyIds.length === 0) return { scrubbedCount: 0 };

    const result = await this.pool.query(
      `UPDATE outbox_events
       SET payload = jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(payload, '{data,ubicacion,latitud}', 'null'::jsonb, true),
                 '{data,ubicacion,longitud}', 'null'::jsonb, true
               ),
               '{data,latitud}', 'null'::jsonb, false
             ),
             '{data,longitud}', 'null'::jsonb, false
           )
       WHERE payload->'data'->>'emergenciaId' = ANY($1::text[])
         AND (
           jsonb_typeof(payload#>'{data,ubicacion,latitud}') = 'string'
           OR jsonb_typeof(payload#>'{data,ubicacion,longitud}') = 'string'
           OR jsonb_typeof(payload#>'{data,latitud}') = 'number'
           OR jsonb_typeof(payload#>'{data,longitud}') = 'number'
         )`,
      [emergencyIds]
    );

    if (result.rowCount > 0) {
      secureLog('info', 'Scrubbed bus coordinates from outbox payloads', {
        scrubbedCount: result.rowCount,
        emergencyIds,
      });
    }
    return { scrubbedCount: result.rowCount };
  }

  // El vínculo con un contexto de zona dice que la emergencia estuvo a pocos
  // cientos de metros de un punto conocido: se borra junto con la ubicación.
  // A esa altura la emergencia ya está cerrada y el vínculo no eleva nada.
  // También se borran sus eventos de vínculo que sigan en el outbox (cualquier
  // estado); lo que ya salió al bus queda bajo la retención del Grupo 1.
  async unlinkZoneContexts(emergencyIds) {
    await this.pool.query(
      'DELETE FROM emergencia_contexto_zona WHERE emergency_id = ANY($1::uuid[])',
      [emergencyIds]
    );
    await this.pool.query(
      `DELETE FROM outbox_events
       WHERE payload->>'type' = $2
         AND payload->'data'->>'emergenciaId' = ANY($1::text[])`,
      [emergencyIds, ZONE_CONTEXT_LINK_EVENT_TYPE]
    );
  }

  // Anonimiza las filas cuyo ciphertext no se puede descifrar con el keyring
  // actual (clave distinta o dato corrupto). Devuelve ids afectados.
  async anonymizeUndecryptableLocations() {
    const candidates = await this.pool.query(
      `SELECT id, location_encrypted
       FROM emergencies
       WHERE location_anonymized_at IS NULL
         AND location_encrypted IS NOT NULL`
    );

    const undecryptable = candidates.rows
      .filter((row) => {
        try {
          this.locationCrypto.decryptLocation(row.location_encrypted);
          return false;
        } catch (error) {
          void error;
          return true;
        }
      })
      .map((row) => row.id);

    if (undecryptable.length === 0) {
      return { anonymizedCount: 0, ids: [] };
    }

    const result = await this.pool.query(
      `UPDATE emergencies
       SET location_encrypted = NULL,
           latitude = NULL,
           longitude = NULL,
           location_anonymized_at = now(),
           updated_at = now()
       WHERE id = ANY($1::uuid[])
       RETURNING id`,
      [undecryptable]
    );

    const ids = result.rows.map((row) => row.id);
    if (ids.length > 0) {
      await this.unlinkZoneContexts(ids);
      await this.scrubOutboxBusCoordinates(ids);
    }

    return {
      anonymizedCount: result.rowCount,
      ids,
    };
  }

  /**
   * Completa barrio en filas que todavía tienen ubicación descifrable y
   * barrio vacío. Las ya anonimizadas quedan sin barrio (no hay forma
   * honesta de recalcular). No toca location_encrypted.
   */
  async backfillBarrios() {
    const candidates = await this.pool.query(
      `SELECT id, latitude, longitude, location_encrypted
       FROM emergencies
       WHERE barrio IS NULL
         AND location_anonymized_at IS NULL
         AND (
           location_encrypted IS NOT NULL
           OR (latitude IS NOT NULL AND longitude IS NOT NULL)
         )`
    );

    const updates = [];
    for (const row of candidates.rows) {
      let latitude = row.latitude != null ? Number(row.latitude) : null;
      let longitude = row.longitude != null ? Number(row.longitude) : null;

      if (row.location_encrypted) {
        try {
          const location = this.locationCrypto.decryptLocation(row.location_encrypted);
          latitude = location.latitude;
          longitude = location.longitude;
        } catch (error) {
          secureLog('warn', 'backfillBarrios: ciphertext indescifrable, se omite', {
            emergencyId: row.id,
            message: error.message,
          });
          continue;
        }
      }

      const barrio = resolveBarrio({ latitude, longitude });
      if (!barrio) continue;
      updates.push({ id: row.id, barrio });
    }

    if (updates.length === 0) {
      return { updatedCount: 0, ids: [] };
    }

    const ids = [];
    for (const item of updates) {
      const result = await this.pool.query(
        `UPDATE emergencies
         SET barrio = $2, updated_at = now()
         WHERE id = $1 AND barrio IS NULL
         RETURNING id`,
        [item.id, item.barrio]
      );
      if (result.rowCount > 0) ids.push(item.id);
    }

    return { updatedCount: ids.length, ids };
  }

  async findPage({ userId, statuses, severity, from, to, assignedOfficerId, emergencyType, page, limit, sortBy, order }) {
    const conditions = [];
    const values = [];

    function addCondition(sql, value) {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    }

    if (userId) addCondition('e.user_id = ?', userId);
    if (statuses.length > 0) addCondition('e.status = ANY(?)', statuses);
    if (severity) addCondition('e.severity = ?', severity);
    if (from) addCondition('e.created_at >= ?', from);
    if (to) addCondition('e.created_at <= ?', to);
    if (assignedOfficerId) addCondition('e.assigned_officer_id = ?', assignedOfficerId);
    // El filtro acepta canónico o alias del front; inválido → ValidationError.
    const normalizedType = assertEmergencyType(emergencyType);
    if (normalizedType) addCondition('e.emergency_type = ?', normalizedType);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    // Prioridad efectiva en SQL (para poder ordenar/paginar en la base):
    // rank 4 = critical ... 1 = low, ELSE 0 (sin severity/incidente
    // reconocido). GREATEST toma el rank MÁS urgente entre la severity
    // individual y la priority del incidente — "máximo entre severity e
    // incident.priority según SEVERITY_LEVELS". Si no hay incidente,
    // i.priority es NULL → ese CASE cae en el ELSE (0), que nunca gana
    // contra la severity individual (rank >= 1), así que el resultado es
    // el mismo que ordenar solo por severity.
    //
    // BUG encontrado en el código heredado (antes de esta tarea, no de
    // #36): la escala anterior tenía critical=1...low=4 y se ordenaba con
    // el mismo DESC/ASC de siempre, así que sortBy=priority (sin order,
    // que por defecto es 'desc') listaba las emergencias MENOS urgentes
    // primero. Con critical=4...low=1, DESC (default) ahora sí lista las
    // más urgentes primero — mismo sentido que created_at DESC = más
    // reciente primero.
    const priorityRank = (column) => `CASE ${column} WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;
    //
    // Prioridad de despacho: a ese rank se le suma 1 (tope 4) si hay un
    // contexto de zona en curso vinculado (cz, ver ZONE_CONTEXT_JOIN_SQL).
    // Va en el ORDER BY y no en JS para que el orden valga entre páginas.
    const sortExpression = sortBy === 'priority'
      ? `LEAST(GREATEST(${priorityRank('e.severity')}, ${priorityRank('i.priority')}) + CASE WHEN cz.tipo IS NULL THEN 0 ELSE 1 END, 4)`
      : 'e.created_at';

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM emergencies e ${where}`,
      values
    );
    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT e.*, o.name AS assigned_officer_name, ${INCIDENT_SELECT_FIELDS}, ${ZONE_CONTEXT_SELECT_FIELDS}
       FROM emergencies e
       LEFT JOIN officers o ON o.id = e.assigned_officer_id
       ${INCIDENT_JOIN_SQL}
       ${ZONE_CONTEXT_JOIN_SQL}
       ${where}
       ORDER BY ${sortExpression} ${direction}, e.created_at ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    return {
      emergencies: result.rows.map((row) => mapEmergencyWithIncident(row, this.locationCrypto)),
      total: countResult.rows[0].total,
    };
  }

  async findOutboxPage({ status, topic, page = 1, limit = 20 }) {
    const conditions = [];
    const values = [];

    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    if (topic) {
      values.push(topic);
      conditions.push(`topic = $${values.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM outbox_events ${where}`,
      values
    );
    const offset = (page - 1) * limit;
    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT id, topic, status, attempts, available_at, locked_at,
              published_at, last_error, created_at
       FROM outbox_events ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    return {
      events: result.rows.map((row) => ({
        id: row.id,
        topic: row.topic,
        status: row.status,
        attempts: row.attempts,
        availableAt: row.available_at,
        lockedAt: row.locked_at,
        publishedAt: row.published_at,
        lastError: row.last_error,
        createdAt: row.created_at,
      })),
      total: countResult.rows[0].total,
    };
  }

  // Actualiza el status y deja el historial en la misma transacción.
  // Si falla cualquiera de los dos pasos, hace ROLLBACK. La transición se
  // valida acá (además de en los controllers) con la fila bloqueada, así
  // ningún endpoint futuro puede saltarse el flujo ni ganar una carrera.
  /**
   * @param {string} id
   * @param {object} options
   * @param {string|null} [options.requireAssignedOfficerId] - si viene, la
   *   transición solo se aplica si ese oficial sigue asignado al momento de
   *   tomar el lock de la fila. Cierra la carrera "se comprobó el oficial,
   *   pero el dispatcher devolvió y reasignó antes del UPDATE". Si no
   *   coincide responde NotFound, igual que una emergencia ajena.
   * @param {string|null} [options.requireStatus] - si viene, la transición
   *   solo se aplica si la emergencia sigue en ese estado con la fila
   *   bloqueada; si no, ConflictError (409). Lo usan validar (PENDING) y
   *   devolver (DISPATCHED), que llegan las dos a VALIDATED.
   * @param {object|null} [options.client] - con `client`, la transición corre
   *   en la transacción del caller (la del OutcomeFactory) sin abrir una propia.
   */
  async updateStatus(id, {
    newStatus, actor = null, reason = null, causasRelacionadas = [], descripcionProblema = null,
    outboxEvent = null, requireAssignedOfficerId = null,
    requireStatus = null, expiration = false, client: externalClient = null,
  }) {
    const options = {
      newStatus, actor, reason, causasRelacionadas, descripcionProblema, outboxEvent,
      requireAssignedOfficerId, requireStatus, expiration,
    };
    if (externalClient) {
      return this.applyStatusUpdate(externalClient, id, options);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.applyStatusUpdate(client, id, options);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async applyStatusUpdate(client, id, {
    newStatus, actor, reason, causasRelacionadas = [], descripcionProblema = null,
    outboxEvent, requireAssignedOfficerId = null, requireStatus = null, expiration = false,
  }) {
    const current = await client.query(
      'SELECT status, assigned_officer_id FROM emergencies WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (current.rows.length === 0) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }
    const previousStatus = current.rows[0].status;
    const assignedOfficerId = current.rows[0].assigned_officer_id;
    if (requireAssignedOfficerId !== null && assignedOfficerId !== requireAssignedOfficerId) {
      throw new NotFoundError(`Emergency with ID ${id} not found`);
    }
    // La expiración no sigue la tabla de transiciones de los endpoints: tiene
    // la suya (expirationTarget) y solo la usa el job del sistema.
    if (expiration) {
      if (expirationTarget(previousStatus) !== newStatus) {
        throw new ConflictError(`Emergency ${id} is ${previousStatus}: cannot expire to ${newStatus}`);
      }
    } else {
      assertTransition(previousStatus, newStatus);
    }
    if (requireStatus !== null && previousStatus !== requireStatus) {
      throw new ConflictError(`Emergency ${id} is ${previousStatus}, expected ${requireStatus}`);
    }

    // closed_at marca el fin de la emergencia en cualquier estado terminal
    // (CLOSED, CANCELLED, DISCARDED): la retención de ubicaciones cuenta las
    // 72 h desde ahí. Al pasar a VALIDATED (validar o devolver) la emergencia
    // queda sin oficial asignado; el oficial se libera más abajo.
    const updated = await client.query(
      `UPDATE emergencies
       SET status = $1,
           updated_at = now(),
           closed_at = CASE WHEN $3::boolean THEN now() ELSE closed_at END,
           assigned_officer_id = CASE WHEN $1 = 'VALIDATED' THEN NULL ELSE assigned_officer_id END,
           causas_relacionadas = CASE
             WHEN $1 = 'RESOLVED' THEN $4::TEXT[]
             ELSE causas_relacionadas
           END,
           descripcion_problema = CASE
             WHEN $1 = 'RESOLVED' THEN $5
             ELSE descripcion_problema
           END
       WHERE id = $2
       RETURNING *`,
      [newStatus, id, isTerminal(newStatus), causasRelacionadas, descripcionProblema]
    );

    const history = await client.query(
      `INSERT INTO emergency_status_history (emergency_id, previous_status, new_status, actor, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, previousStatus, newStatus, actor, reason]
    );

    // Al cancelar, cerrar o devolver a VALIDATED, el oficial asignado vuelve a disponible
    // en la misma transacción (si no, se agotan en demo y reasignar el mismo da 409).
    if (
      assignedOfficerId
      && (newStatus === 'CANCELLED' || newStatus === 'CLOSED' || newStatus === 'VALIDATED')
    ) {
      await client.query(
        `UPDATE officers SET status = 'disponible', updated_at = now()
         WHERE id = $1 AND status = 'ocupado'`,
        [assignedOfficerId]
      );
    }

    if (outboxEvent) {
      await this.insertOutboxEvent(client, outboxEvent, {
        emergency: mapEmergency(updated.rows[0], this.locationCrypto),
        history: mapHistoryEntry(history.rows[0]),
      });
    }

    return {
      emergency: mapEmergency(updated.rows[0], this.locationCrypto),
      history: mapHistoryEntry(history.rows[0]),
    };
  }

  // Emergencias nacidas de una causa externa (p. ej. la cobertura preventiva
  // de un evento público). FOR UPDATE: corre dentro de la transacción del
  // OutcomeFactory y evita que dos entregas del mismo evento creen o cancelen
  // en paralelo.
  async findByCausa(client, { causaTipo, causaId, emergencyType = null }) {
    const executor = client || this.pool;
    const result = await executor.query(
      `SELECT id, status, emergency_type
       FROM emergencies
       WHERE causa_tipo = $1 AND causa_id = $2
         AND ($3::text IS NULL OR emergency_type = $3)
       ORDER BY created_at
       FOR UPDATE`,
      [causaTipo, causaId, emergencyType]
    );
    return result.rows.map((row) => ({ id: row.id, status: row.status, emergencyType: row.emergency_type }));
  }

  /**
   * Candidatos recientes para el job de deteccion de incidentes (#60): sin
   * JOIN a officers, sin paginacion, sin COUNT -- el consumidor es el job,
   * no un endpoint HTTP. Recibe un tipo (`emergencyType`) o varios
   * (`emergencyTypes`): el job pide todos los agrupables en UNA sola query y
   * los separa en memoria por emergencyType. Las emergencias en estado
   * terminal (cerradas, canceladas, descartadas) no son candidatas.
   * Devuelve lat/lng ya descifrados porque el job los pasa directo a
   * groupNearbyEmergencies.
   * Una fila cuyo ciphertext no se puede descifrar se excluye del
   * resultado (no puede tumbar la corrida del job), dejando constancia
   * con secureLog de cual id se excluyo y por que.
   */
  async findRecentByType({ emergencyType, emergencyTypes = [emergencyType], since }) {
    const result = await this.pool.query(
      `SELECT id, correlation_id, user_id, emergency_type, latitude, longitude, location_encrypted,
              severity, incident_id, created_at
       FROM emergencies
       WHERE emergency_type = ANY($1::text[])
         AND created_at >= $2
         AND status <> ALL($3::text[])`,
      [emergencyTypes, since, TERMINAL_STATUSES]
    );

    const candidates = [];
    for (const row of result.rows) {
      if (!row.location_encrypted) {
        candidates.push({
          id: row.id,
          correlationId: row.correlation_id,
          userId: row.user_id,
          emergencyType: row.emergency_type,
          latitude: null,
          longitude: null,
          severity: row.severity,
          incidentId: row.incident_id,
          createdAt: row.created_at,
        });
        continue;
      }

      try {
        const location = this.locationCrypto.decryptLocation(row.location_encrypted);
        candidates.push({
          id: row.id,
          correlationId: row.correlation_id,
          userId: row.user_id,
          emergencyType: row.emergency_type,
          latitude: location.latitude,
          longitude: location.longitude,
          severity: row.severity,
          incidentId: row.incident_id,
          createdAt: row.created_at,
        });
      } catch (error) {
        secureLog('warn', 'Emergency excluded from findRecentByType: location ciphertext could not be decrypted', {
          emergencyId: row.id,
          message: error.message,
        });
      }
    }

    return candidates;
  }

  async setIncidentId(emergencyId, incidentId) {
    const result = await this.pool.query(
      'UPDATE emergencies SET incident_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [incidentId, emergencyId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError(`Emergency with ID ${emergencyId} not found`);
    }
    return mapEmergency(result.rows[0], this.locationCrypto);
  }

  /**
   * Asigna un oficial disponible: VALIDATED → DISPATCHED + oficial ocupado.
   * Todo en una transacción (emergencia + officers + historial + outbox).
   */
  async assignOfficer(id, { officerId, actor = null, outboxEvent = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query(
        'SELECT * FROM emergencies WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (current.rows.length === 0) {
        throw new NotFoundError(`Emergency with ID ${id} not found`);
      }

      const previousStatus = current.rows[0].status;
      assertTransition(previousStatus, 'DISPATCHED');

      const officerResult = await client.query(
        'SELECT * FROM officers WHERE id = $1 FOR UPDATE',
        [officerId]
      );
      if (officerResult.rows.length === 0) {
        throw new NotFoundError(`Officer with ID ${officerId} not found`);
      }
      const officerRow = officerResult.rows[0];
      if (officerRow.status !== 'disponible') {
        throw new ConflictError(`Officer ${officerId} is not available`);
      }

      const previousOfficerId = current.rows[0].assigned_officer_id;
      if (previousOfficerId && previousOfficerId !== officerId) {
        await client.query(
          `UPDATE officers SET status = 'disponible', updated_at = now()
           WHERE id = $1 AND status = 'ocupado'`,
          [previousOfficerId]
        );
      }

      const updated = await client.query(
        `UPDATE emergencies e
         SET status = 'DISPATCHED', assigned_officer_id = $1, updated_at = now()
         WHERE e.id = $2
         RETURNING e.*`,
        [officerId, id]
      );

      await client.query(
        `UPDATE officers SET status = 'ocupado', updated_at = now() WHERE id = $1`,
        [officerId]
      );

      const history = await client.query(
        `INSERT INTO emergency_status_history (emergency_id, previous_status, new_status, actor, reason)
         VALUES ($1, $2, 'DISPATCHED', $3, $4) RETURNING *`,
        [id, previousStatus, actor, `Assigned officer ${officerId}`]
      );

      const officer = mapOfficer(officerRow);
      officer.status = 'ocupado';
      const emergency = mapEmergency(
        { ...updated.rows[0], assigned_officer_name: officer.name },
        this.locationCrypto
      );
      const historyEntry = mapHistoryEntry(history.rows[0]);

      if (outboxEvent) {
        await this.insertOutboxEvent(client, outboxEvent, {
          emergency,
          history: historyEntry,
        });
      }

      await client.query('COMMIT');

      return { emergency, history: historyEntry, officer };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { EmergencyRepository, mapEmergency };
