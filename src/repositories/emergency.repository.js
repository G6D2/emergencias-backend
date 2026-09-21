const { NotFoundError, ConflictError } = require('../errors/app-errors');
const { assertTransition } = require('../domain/emergency-status');
const { assertEmergencyType } = require('../domain/emergency-type');
const { createLocationCrypto } = require('../security/location-crypto');
const { randomUUID } = require('crypto');
const { secureLog } = require('../security/secure-log');
const { mapOfficer } = require('./officer.repository');
const { effectivePriority } = require('../domain/severity');

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

// mapEmergency + incident: null|{...} + effectivePriority (máximo entre
// severity individual y incident.priority, ver src/domain/severity.js).
function mapEmergencyWithIncident(row, locationCrypto) {
  const emergency = mapEmergency(row, locationCrypto);
  if (!emergency) return null;
  const incident = mapIncidentSummary(row);
  return {
    ...emergency,
    incident,
    effectivePriority: effectivePriority(emergency.severity, incident ? incident.priority : null),
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

// INSERT compartido por las dos ramas de create() (sin/con outbox).
// correlation_id cae en el propio id si no viene (tarea #58).
const INSERT_SQL = `INSERT INTO emergencies (
     id, correlation_id, user_id, latitude, longitude, location_encrypted,
     description, severity, emergency_type, status
   )
   VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7, COALESCE($8, 'PENDING'))
   RETURNING *`;

// Repository de persistencia de emergencies.
// No sabe nada de Kafka, controllers ni HTTP: solo SQL + cifrado de ubicación.
class EmergencyRepository {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.locationCrypto = options.locationCrypto || createLocationCrypto();
  }

  async create({
    id, correlationId, userId, latitude, longitude, address, description, severity, emergencyType, status,
    outboxEvent = null,
  }) {
    const locationEncrypted = this.locationCrypto.encryptLocation({ latitude, longitude, address });
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
    ];

    if (!outboxEvent) {
      const result = await this.pool.query(INSERT_SQL, insertValues);
      return mapEmergency(result.rows[0], this.locationCrypto);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(INSERT_SQL, insertValues);
      const emergency = mapEmergency(result.rows[0], this.locationCrypto);
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

  async findAll() {
    const result = await this.pool.query(
      `SELECT e.*, o.name AS assigned_officer_name
       FROM emergencies e
       LEFT JOIN officers o ON o.id = e.assigned_officer_id
       ORDER BY e.created_at DESC`
    );
    return result.rows.map((row) => mapEmergency(row, this.locationCrypto));
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
      `SELECT e.*, o.name AS assigned_officer_name, ${INCIDENT_SELECT_FIELDS}
       FROM emergencies e
       LEFT JOIN officers o ON o.id = e.assigned_officer_id
       ${INCIDENT_JOIN_SQL}
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

  async findAccessAuditByEmergencyId(emergencyId) {
    const result = await this.pool.query(
      `SELECT * FROM emergency_access_audit
       WHERE emergency_id = $1
       ORDER BY created_at ASC`,
      [emergencyId]
    );
    return result.rows.map(mapAccessAudit);
  }

  /**
   * Borra ciphertext de ubicaciones más viejas que retentionHours.
   * Las filas siguen existiendo; lat/lng quedan null (minimización).
   */
  async anonymizeExpiredLocations(retentionHours) {
    const hours = Number(retentionHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error('retentionHours must be a positive number');
    }

    const result = await this.pool.query(
      `UPDATE emergencies
       SET location_encrypted = NULL,
           latitude = NULL,
           longitude = NULL,
           location_anonymized_at = now(),
           updated_at = now()
       WHERE location_anonymized_at IS NULL
         AND (
           location_encrypted IS NOT NULL
           OR latitude IS NOT NULL
           OR longitude IS NOT NULL
         )
         AND created_at < now() - ($1::double precision * interval '1 hour')
       RETURNING id`,
      [hours]
    );

    return {
      anonymizedCount: result.rowCount,
      ids: result.rows.map((row) => row.id),
    };
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

    return {
      anonymizedCount: result.rowCount,
      ids: result.rows.map((row) => row.id),
    };
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
    const sortExpression = sortBy === 'priority'
      ? `GREATEST(${priorityRank('e.severity')}, ${priorityRank('i.priority')})`
      : 'e.created_at';

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM emergencies e ${where}`,
      values
    );
    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT e.*, o.name AS assigned_officer_name, ${INCIDENT_SELECT_FIELDS}
       FROM emergencies e
       LEFT JOIN officers o ON o.id = e.assigned_officer_id
       ${INCIDENT_JOIN_SQL}
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
  async updateStatus(id, { newStatus, actor = null, reason = null, outboxEvent = null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query(
        'SELECT status, assigned_officer_id FROM emergencies WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (current.rows.length === 0) {
        throw new NotFoundError(`Emergency with ID ${id} not found`);
      }
      const previousStatus = current.rows[0].status;
      const assignedOfficerId = current.rows[0].assigned_officer_id;
      assertTransition(previousStatus, newStatus);

      const updated = await client.query(
        `UPDATE emergencies
         SET status = $1,
             updated_at = now(),
             closed_at = CASE WHEN $1 = 'CLOSED' THEN now() ELSE closed_at END
         WHERE id = $2
         RETURNING *`,
        [newStatus, id]
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

      await client.query('COMMIT');

      return {
        emergency: mapEmergency(updated.rows[0], this.locationCrypto),
        history: mapHistoryEntry(history.rows[0]),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Candidatos recientes de un emergencyType para el job de deteccion de
   * incidentes (#60): sin JOIN a officers, sin paginacion, sin COUNT --
   * el consumidor es el job, no un endpoint HTTP. Devuelve lat/lng ya
   * descifrados porque el job los pasa directo a groupNearbyEmergencies.
   * Una fila cuyo ciphertext no se puede descifrar se excluye del
   * resultado (no puede tumbar la corrida del job), dejando constancia
   * con secureLog de cual id se excluyo y por que.
   */
  async findRecentByType({ emergencyType, since }) {
    const result = await this.pool.query(
      `SELECT id, correlation_id, user_id, latitude, longitude, location_encrypted,
              severity, incident_id, created_at
       FROM emergencies
       WHERE emergency_type = $1 AND created_at >= $2`,
      [emergencyType, since]
    );

    const candidates = [];
    for (const row of result.rows) {
      if (!row.location_encrypted) {
        candidates.push({
          id: row.id,
          correlationId: row.correlation_id,
          userId: row.user_id,
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
