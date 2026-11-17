# Secuencias

Para qué sirve: mostrar paso a paso los flujos que se muestran en la demo, con los nombres
reales de funciones/archivos de front y back, para que sirvan de guion de demo y de referencia
de debugging. Las secuencias f) y g) son los casos transversales con otros módulos.

## a) Ciudadano dispara el botón SOS

```mermaid
sequenceDiagram
    actor Ciudadano
    participant Front as Front (InicioClient + sosController)
    participant BFF as BFF (Next.js /api/geocode, /api/backend)
    participant Geo as BigDataCloud / Nominatim
    participant Back as Backend (POST /api/panic-button)
    participant DB as Neon Postgres

    Ciudadano->>Front: toca "ANTIPANICO"
    Front->>Front: createSosController().start() — cuenta regresiva 3s (SOS_COUNTDOWN_SECONDS), cancelable
    par ubicación (obligatoria)
        Front->>Front: getCurrentLocation() (navigator.geolocation)
    and dirección legible (opcional, timeout 2.5s)
        Front->>BFF: GET /api/geocode?lat&lng
        BFF->>Geo: reverseGeocodeServer(lat, lng)
        Geo-->>BFF: label | null
        BFF-->>Front: { label }
    end
    Note over Front: a los 3s (o antes si se cancela) llega a 0 -> finish()
    Front->>BFF: POST /api/backend/api/panic-button (cookie httpOnly, same-origin)
    BFF->>Back: POST /api/panic-button (Authorization: Bearer, retry 502/503/504 hasta 24s)
    Back->>Back: valida location.latitude/longitude (rango -90..90 / -180..180)
    Back->>Back: assertEmergencyType(emergencyType) o "PANICO" por default
    Back->>Back: severityForType(emergencyType) — severity del body se ignora
    Back->>Back: normalizeAddress(address) — trunca a 200 chars, sin saltos de línea
    Back->>Back: locationCrypto.encryptLocation({latitude, longitude, address}) — AES-256-GCM
    Back->>DB: BEGIN
    Back->>DB: INSERT INTO emergencies (status=PENDING, location_encrypted, correlation_id=id, ...)
    Back->>DB: INSERT INTO outbox_events (topic=emergencias.boton-panico, payload=EmergenciaCreada)
    Back->>DB: COMMIT
    DB-->>Back: fila de emergencies
    Back-->>BFF: 201 { success, emergencyId, message, data }
    BFF-->>Front: 201 (passthrough)
    Front->>Ciudadano: notificación "Alerta enviada" + redirect a /mis-alertas/:emergencyId
```

## b) Dispatcher y oficial: listado, validar, asignar, seguimiento del oficial, cerrar

```mermaid
sequenceDiagram
    actor Dispatcher
    actor Oficial
    participant Front as Front (DispatcherView)
    participant BFF as BFF (/api/backend/*)
    participant Back as Backend (/api/emergencies, /api/officers)
    participant DB as Neon Postgres

    loop cada 30000ms (POLLING_INTERVAL_MS)
        Front->>BFF: GET /api/backend/api/emergencies?limit=100&sortBy=createdAt&order=desc
        BFF->>Back: GET /api/emergencies (Bearer dispatcher)
        Back->>DB: SELECT ... LEFT JOIN officers, paginado
        DB-->>Back: filas
        Back-->>BFF: { data, pagination }
        BFF-->>Front: passthrough
        Front->>Front: compara con la lista en memoria, resalta las nuevas 6s
    end

    Dispatcher->>Front: click "Validar"
    Front->>BFF: PATCH /api/backend/api/emergencies/:id/validate
    BFF->>Back: PATCH /api/emergencies/:id/validate (Bearer dispatcher)
    Back->>Back: assertTransition(PENDING, VALIDATED)
    Back->>DB: BEGIN, UPDATE status, INSERT history, INSERT outbox (EmergenciaActualizada), COMMIT
    Back-->>Front: 200 { data } (vía BFF)

    Dispatcher->>Front: abre modal, elige oficial disponible
    Front->>BFF: PATCH /api/backend/api/emergencies/:id/assign { officerId }
    BFF->>Back: PATCH /api/emergencies/:id/assign (Bearer dispatcher)
    Back->>Back: assertTransition(VALIDATED, DISPATCHED)
    Back->>DB: BEGIN, SELECT officer FOR UPDATE, verifica status=disponible
    Back->>DB: UPDATE emergencies (status=DISPATCHED, assigned_officer_id), UPDATE officers (status=ocupado)
    Back->>DB: INSERT history, INSERT outbox (EmergenciaActualizada DESPACHADA, asignadoA=X), COMMIT
    Back-->>Front: 200 { data, assignedOfficer } (vía BFF)

    Note over Oficial,Back: el oficial los dispara desde /oficial en el front, vía BFF. Se dibujan directo contra el backend para simplificar (token officer, sub = id del oficial)
    Oficial->>Back: PATCH /api/emergencies/:id/en-route (Bearer officer)
    Back->>Back: canAdvanceEmergencyStatus (sub === assigned_officer_id, si no 404) + assertTransition(DISPATCHED, EN_ROUTE)
    Back->>DB: BEGIN, SELECT ... FOR UPDATE (oficial sigue asignado), UPDATE status, INSERT history, INSERT outbox (EmergenciaActualizada), COMMIT
    Back-->>Oficial: 200 { data }
    Oficial->>Back: PATCH /api/emergencies/:id/on-scene (EN_ROUTE → ON_SCENE, mismo patrón)
    Oficial->>Back: PATCH /api/emergencies/:id/resolve (ON_SCENE → RESOLVED, resueltoAt en el evento)

    Dispatcher->>Front: click "Cerrar" (emergencia en RESOLVED)
    Front->>BFF: PATCH /api/backend/api/emergencies/:id/close
    BFF->>Back: PATCH /api/emergencies/:id/close (Bearer dispatcher)
    Back->>Back: assertTransition(RESOLVED, CLOSED)
    Back->>DB: BEGIN, UPDATE status=CLOSED, closed_at=now(), INSERT history, oficial a disponible, INSERT outbox (EmergenciaActualizada CERRADA), COMMIT
    Back-->>Front: 200 { data } (vía BFF)
```

## c) Cancelación por el ciudadano y publicación confiable (outbox → Kafka)

```mermaid
sequenceDiagram
    actor Ciudadano
    participant Front as Front (AlertDetailPage)
    participant BFF as BFF (/api/backend/*)
    participant Back as Backend (/api/emergencies/:id/cancel)
    participant DB as outbox_events (Neon Postgres)
    participant Pub as OutboxPublisher (poll cada 5000ms)
    participant Kafka as Kafka (bus del Grupo 1)

    Ciudadano->>Front: confirma "Cancelar asistencia" (motivo opcional)
    Front->>BFF: PATCH /api/backend/api/emergencies/:id/cancel { reason }
    BFF->>Back: PATCH /api/emergencies/:id/cancel (Bearer citizen)
    Back->>Back: canCancelEmergency(user, emergency) — solo dueño
    Back->>Back: assertTransition(status, CANCELLED)
    Back->>DB: BEGIN, UPDATE status=CANCELLED, libera oficial si estaba asignado
    Back->>DB: INSERT history, INSERT outbox_events (status=PENDING, payload=EmergenciaActualizada CANCELADA), COMMIT
    Back-->>Front: 200 { data } (vía BFF)

    alt OUTBOX_PUBLISHER_ENABLED distinto de true
        Note over Pub,Kafka: el publisher no arranca: el evento queda PENDING en outbox_events (se ve en GET /api/outbox-events)
    else publisher prendido
    Pub->>DB: al arrancar, skipPendingBefore(): PENDING anteriores a OUTBOX_PUBLISH_SINCE pasan a SKIPPED
    loop runOnce() cada intervalMs (default 5000ms)
        alt kafkaService.isEnabled() === true
            Note over Pub: si está en pausa (el bus no respondió), no reclama nada
            Pub->>DB: claimBatch() — UPDATE ... SET PROCESSING FOR UPDATE SKIP LOCKED LIMIT 50, a lo sumo un evento por emergencia (ninguno si hay uno anterior PENDING/PROCESSING/FAILED)
            DB-->>Pub: lote de eventos reclamados (se vuelve a reclamar hasta 50 por corrida)
            loop por evento del lote
                Pub->>Kafka: producer.send(topic, payload)
                alt envío OK
                    Kafka-->>Pub: ack
                    Pub->>DB: markPublished(id, attempts) — status=PUBLISHED (solo si sigue PROCESSING con ese attempts)
                else error propio del evento (400/403/404/413)
                    Pub->>DB: markFailed(id, attempts) — FAILED, frena a los posteriores de su emergencia (mismo filtro)
                else error transitorio (red, timeout, 5xx, 429) o Kafka no conectado
                    Pub->>DB: markFailed(id, attempts) — PENDING con backoff (sin límite de intentos)
                    Pub->>DB: releaseClaims(resto del lote) — vuelven a PENDING sin gastar intento
                    Note over Pub: corta el lote y pausa (Retry-After o 5 s, 10 s, 20 s… hasta 5 min)
                end
            end
        else kafkaService.isEnabled() === false (KAFKA_ENABLED=false)
            Note over Pub,Kafka: no se llama claimBatch(): los eventos quedan PENDING
        end
        Pub->>DB: purgePublished() — borra PUBLISHED con más de OUTBOX_PUBLISHED_RETENTION_HOURS (168h)
    end
    end
```

## d) Job de detección de incidentes (cada 60s)

```mermaid
sequenceDiagram
    participant Job as IncidentDetectionJob
    participant DB as Neon Postgres
    participant Strategy as IncidentDetectionStrategy (detectGroups)
    participant Dbscan as DbscanGrouper (primaria)
    participant RuleBased as RuleBasedGrouper (fallback)
    participant Rules as RiskEngine
    participant Repo as IncidentRepository

    loop cada 60000ms (INCIDENT_DETECTION_INTERVAL_MS)
        Job->>DB: pg_try_advisory_lock(875312047) en conexión dedicada
        alt lock ocupado por otra instancia
            DB-->>Job: locked = false
            Note over Job: se saltea esta corrida, hay otra en 60s
        else lock libre
            DB-->>Job: locked = true
            loop por cada emergencyType del catálogo
                Job->>DB: findRecentByType(emergencyType, since = now - 15min)
                DB-->>Job: candidatos con lat/lng ya descifrados
                Job->>Strategy: detectGroups(candidatos, options, primary=Dbscan, fallback=RuleBased)
                Strategy->>Dbscan: groupNearbyEmergenciesDbscan (radio 300m, minPts=INCIDENT_MIN_CITIZENS)
                alt DBSCAN corre sin excepción (incluye resultado vacío)
                    Dbscan-->>Strategy: grupos (>= minUniqueCitizens ciudadanos únicos, puede ser [])
                    Strategy-->>Job: { groups, strategy: 'primary' }
                    Note over Job: algorithmVersion = dbscan-v1
                else DBSCAN lanza excepción
                    Dbscan-->>Strategy: excepción
                    Strategy->>Strategy: secureLog('warn', primary strategy failed, using fallback)
                    Strategy->>RuleBased: groupNearbyEmergencies (Union-Find, radio 300m, min 2 ciudadanos)
                    RuleBased-->>Strategy: grupos válidos por componente conexa
                    Strategy-->>Job: { groups, strategy: 'fallback' }
                    Note over Job: algorithmVersion = rule-based-v1
                end
                Job->>Rules: calculateIncidentScore + scoreToPriority
                Rules-->>Job: score, reasonCodes, priority del incidente
                Job->>Rules: applyPriorityInvariant(severity individual, priority incidente)
                Rules-->>Job: finalPriority por miembro, nunca por debajo de su severity
                alt grupo con incidentes previos distintos entre sí
                    Note over Job: AMBIGUOUS_EXISTING_INCIDENTS, se descarta el grupo
                else grupo consistente
                    Job->>Repo: create() si es incidente nuevo, o addMember() a uno existente
                    Job->>Repo: applyScoringDecision(incidentId, factors, score, priority)
                    Repo->>DB: BEGIN, SELECT priority FOR UPDATE, UPDATE incidents, COMMIT
                    alt priority cambió respecto a la anterior
                        Repo->>DB: INSERT outbox_events (EmergenciaPriorizada) por cada miembro
                    else priority sin cambios
                        Note over Repo: no se publica evento, evita ruido en cada corrida
                    end
                end
            end
            Job->>DB: pg_advisory_unlock(875312047)
        end
    end
```

## e) Cobertura preventiva (consumo de un evento de Espacios)

```mermaid
sequenceDiagram
    participant Esp as Espacios Públicos
    participant Bus as Bus del Grupo 1 (Kafka + registry)
    participant L as EventoComunitarioPublicadoListener
    participant F as OutcomeFactory
    participant DB as Neon Postgres

    Esp->>Bus: EventoComunitarioPublicado (Avro)
    Bus->>L: mensaje (consumer group com.citypass.emergencias.eventos, vía EventConsumer)
    L->>Bus: decode: schema por id (Bearer del Login Federado)
    L->>L: regla ProgramarCoberturaPreventivaRule: capacidad >= 500 y estado != CANCELLED
    alt la regla no aplica
        L->>F: process([], context) — solo registra el eventId
    else aplica
        L->>F: process([ProgramarCobertura], context)
    end
    F->>DB: BEGIN, INSERT eventos_procesados (ON CONFLICT DO NOTHING)
    alt eventId ya procesado (duplicado o republicación)
        F->>DB: ROLLBACK (sin efectos)
    else nuevo
        opt hay un ProgramarCobertura
            F->>DB: findByCausa(EVENTO_PUBLICO, eventoId) FOR UPDATE
            alt ya hay cobertura para ese evento
                Note over F,DB: no crea otra (además lo impide el índice único de V23)
            else no hay
                F->>DB: INSERT emergencies (PREVENTIVA, EXTERNAL, user_id NULL, severity low, PENDING)
                F->>DB: INSERT outbox_events (EmergenciaCreada con causaTipo/causaId)
            end
        end
        F->>DB: COMMIT
    end
    Note over L,Bus: kafkajs confirma el offset. Un error transitorio no lo confirma (reentrega). Uno permanente queda DISCARDED en eventos_procesados
```

`EventoCancelado` sigue el mismo camino con `CancelarCoberturaPreventivaRule`: si la cobertura
de ese `eventoId` está en `PENDING` o `VALIDATED`, la pasa a `CANCELLED` (actor `eda:espacios`)
con historial y `EmergenciaActualizada`.

## f) Caso transversal: reclamo por ciclovía obstruida → intervención `TRANSITO`

Caso 3 del Hito 2. Un vecino reclama por un auto estacionado en la ciclovía; Movilidad evalúa la
obstrucción y le pide la emergencia a Emergencias, que crea la intervención y la sigue con el
flujo normal de dispatcher y oficial. Qué evento crea la intervención lo decide
`RECLAMO_INTERVENCION_DISPARADOR` (`src/listeners/reclamo-intervencion/disparador.js`):
`movilidad` (default, el que corre en producción), `reclamo` (plan B: solo el `ReclamoCreado`) o
`ambos` (el primero que llegue; el otro la encuentra creada).

```mermaid
sequenceDiagram
    actor Ciudadano
    participant Rec as Reclamos
    participant Mov as Movilidad
    participant Bus as Bus del Grupo 1 (Kafka + gateway)
    participant L as Listeners reclamo-intervencion
    participant F as OutcomeFactory + handlers
    participant DB as Neon Postgres
    participant Pub as OutboxPublisher (gateway)
    actor Dispatcher
    actor Oficial

    Ciudadano->>Rec: reclamo "auto en la ciclovía" (categoria TRANSITO, objetoAfectado CICLOVIA)
    Rec->>Bus: ReclamoCreado (com.citypass.reclamos.ReclamoCreado.v3)
    Bus->>L: ReclamoCreado → ReclamoCreadoListener
    alt RECLAMO_INTERVENCION_DISPARADOR = movilidad (default)
        L->>F: process([], context) — solo registra el eventId
    else reclamo o ambos (plan B), TRANSITO + CICLOVIA y estado no final
        L->>F: process([CrearIntervencionPorReclamo], context)
        Note over F,DB: mismo alta que abajo, con la prioridad del reclamo
    end
    Bus->>Mov: ReclamoCreado
    Mov->>Mov: evalúa la obstrucción (ciclovía, afecta la circulación, prioridad ALTA o CRITICA)
    Mov->>Bus: EmergenciaSolicitada (reclamoId, correlationId, prioridad, latitud/longitud)
    Bus->>L: EmergenciaSolicitada → EmergenciaSolicitadaListener
    L->>L: CrearIntervencionPorSolicitudRule: disparador movilidad o ambos, y trae reclamoId
    L->>F: process([CrearIntervencionPorReclamo], context)
    F->>DB: BEGIN, INSERT eventos_procesados (ON CONFLICT DO NOTHING)
    alt eventId ya procesado
        F->>DB: ROLLBACK (sin efectos)
    else nuevo
        F->>DB: findByCausa(RECLAMO, reclamoId)
        alt ya hay intervención (la creó el otro disparador)
            Note over F,DB: no crea otra
        else no hay
            F->>DB: SAVEPOINT, INSERT emergencies (TRANSITO, EXTERNAL, user_id NULL, PENDING, causa RECLAMO, severity desde prioridad, correlationId de Movilidad)
            F->>DB: linkZoneContexts (si cae en un contexto de zona en curso) + INSERT outbox_events (EmergenciaCreada, afectaCirculacion = true)
            Note over F,DB: si otro evento del mismo reclamo ganó la carrera, choca con uq_emergencies_reclamo_causa (V29): ROLLBACK TO SAVEPOINT y queda como "ya creada"
        end
        F->>DB: COMMIT
    end
    Pub->>Bus: EmergenciaCreada (com.citypass.emergencias.EmergenciaCreada, key = correlationId)

    Note over Dispatcher,Oficial: desde acá, el flujo (b): cada paso deja historial y un EmergenciaActualizada en el outbox
    Dispatcher->>DB: PATCH .../validate y .../assign (vía BFF y backend)
    Oficial->>DB: PATCH .../en-route, .../on-scene, .../resolve
    Dispatcher->>DB: PATCH .../close
    Pub->>Bus: EmergenciaActualizada por cada paso, en orden por emergencia

    opt el reclamo termina antes de que salga el agente
        Rec->>Bus: ReclamoActualizado (estadoNuevo RESUELTO, RECHAZADO o CERRADO)
        Bus->>L: ReclamoActualizado → ReclamoActualizadoListener
        L->>F: process([CerrarIntervencionPorReclamo], context)
        F->>DB: findByCausa(RECLAMO, reclamoId)
        alt intervención en PENDING o VALIDATED
            F->>DB: UPDATE status = CANCELLED (actor eda:reclamos, reason "Reclamo RESUELTO") + historial + outbox EmergenciaActualizada CANCELADA
        else ya despachada o terminada
            Note over F,DB: no la toca: la termina el oficial
        end
        F->>DB: COMMIT
    end
```

## g) Alerta climática: contextos de zona, `PREVENTIVA` y suba de prioridad

Espacios confirma una alerta climática y después la finaliza, con el mismo `alertaId`. Solo
`ALTA` y `CRITICA` hacen algo. Los dos listeners son opt-in: sin
`EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA` y `EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA` el
consumer no se suscribe (en producción están cargadas desde el 17/11/2026).

```mermaid
sequenceDiagram
    participant Esp as Espacios Públicos
    participant Bus as Bus del Grupo 1 (Kafka + registry)
    participant L as Listeners alerta-climatica
    participant F as OutcomeFactory + handlers
    participant DB as Neon Postgres
    actor Ciudadano
    participant Back as Backend HTTP
    actor Dispatcher

    Esp->>Bus: CriticidadClimaticaConfirmada (alertaId, nivelCriticidad, fenomeno, ubicaciones, barrios, vigenciaDesde/Hasta)
    Bus->>L: → CriticidadClimaticaConfirmadaListener
    alt nivel BAJA o MEDIA
        L->>F: process([], context) — solo registra el eventId
    else nivel ALTA o CRITICA
        L->>F: process([CrearEmergenciaClimatica, RegistrarContextosClimaticos], context)
        F->>DB: BEGIN, INSERT eventos_procesados, pg_advisory_xact_lock (grupo de la alerta)
        alt la alerta ya se finalizó (hay marca de baja alertaId)
            Note over F,DB: no crea contextos ni emergencia
        else vigente
            F->>DB: INSERT emergencies (PREVENTIVA por alertaId, causa EVENTO_CLIMATICO, high o critical, en el primer punto) + outbox EmergenciaCreada (prioridadOriginal = prioridad)
            F->>DB: upsert contexto_zona ALERTA_CLIMATICA por punto (alertaId#n, radio 500 m ALTA o 1000 m CRITICA, ventana, nivel, fenómeno, barrios)
        end
        F->>DB: COMMIT
    end

    Ciudadano->>Back: POST /api/panic-button dentro del radio, con la alerta en curso
    Back->>DB: BEGIN, INSERT emergencies (coordenada cifrada)
    Back->>DB: linkZoneContexts: contextos en curso, haversine ≤ radio_metros con la coordenada en memoria → INSERT emergencia_contexto_zona
    Back->>DB: INSERT outbox_events (EmergenciaCreada con la prioridad sin ajuste), COMMIT

    loop polling cada 30 s del tablero
        Dispatcher->>Back: GET /api/emergencies?sortBy=priority
        Back->>DB: SELECT ... LEFT JOIN LATERAL contexto en curso
        Back-->>Dispatcher: dispatchPriority = efectiva + 1 nivel, priorityContext "Alerta climática CRITICA: tormenta fuerte"
        Dispatcher->>Back: GET /api/contextos-zona/activos
        Back-->>Dispatcher: banner: una entrada por alerta (nivel, fenómeno, barrios, vigencia, enCurso)
    end

    Esp->>Bus: CriticidadClimaticaFinalizada (alertaId, finalizadaEn)
    Bus->>L: → CriticidadClimaticaFinalizadaListener
    L->>F: process([CancelarEmergenciaClimatica, DarDeBajaContextosClimaticos], context)
    F->>DB: BEGIN, INSERT eventos_procesados, mismo advisory lock
    alt PREVENTIVA en PENDING o VALIDATED
        F->>DB: UPDATE status = CANCELLED (actor eda:espacios) + historial + outbox EmergenciaActualizada CANCELADA
    else ya despachada
        Note over F,DB: queda como está
    end
    F->>DB: darDeBajaGrupo: marca alertaId + dado_de_baja_en en todos los puntos
    F->>DB: COMMIT
    Note over Dispatcher,DB: en la próxima lectura no hay contexto en curso: dispatchPriority vuelve a la efectiva y la alerta sale del banner
```

## Leyenda

| Elemento | Notas |
|---|---|
| BFF | Next.js del repo `Frontend`, corre server-side en Render; guarda el JWT en cookie `httpOnly` (`citypass_session`) y nunca lo expone al browser |
| `fetchBackend` | Reintenta 502/503/504 hasta 6 veces (~24s) porque Render (free) duerme el backend tras 15 min sin tráfico |
| Outbox transaccional | El `INSERT` en `emergencies`/`emergency_status_history` y el `INSERT` en `outbox_events` van en la **misma transacción**: si Kafka está caído, la emergencia igual queda persistida |
| `OUTBOX_PUBLISHER_ENABLED=false` | El publisher del flujo (c) no arranca y los eventos se acumulan `PENDING`. Producción corre desde el 05/11 con `true` y `EDA_PUBLISHER_MODE=gateway` |
| Oficial (b) | El oficial opera desde `/oficial` en el `Frontend`: lista lo que tiene asignado y avanza con un botón por paso. Los tres endpoints validan que el `sub` del token sea el oficial asignado; en local, con el dev login sin modo estricto (`of-001`/`of-002`), también se pueden llamar por Swagger o Postman |
| `address` en el SOS | La dirección legible que resuelve el front (`resolveEmergencyAddress`, geocode inverso con timeout 2.5s) viaja al backend en el mismo body que `latitude`/`longitude`, como campo `address` (≤200 caracteres); `normalizeAddress` la sanea y `locationCrypto.encryptLocation` la guarda **dentro del mismo blob cifrado** que la ubicación (ver `02-modelo-entidad-relacion.md`) |
| Advisory lock del job (d) | `pg_try_advisory_lock` no bloquea: si otra instancia del backend (p. ej. el stack de backup activado) ya tiene el lock, esa corrida se saltea en vez de esperar — hay otra corrida 60s después |
| `EmergenciaPriorizada` condicional | Solo se publica si `applyScoringDecision` detecta que la `priority` del incidente cambió respecto a la que tenía antes (`NULL` cuenta como distinta, así que la primera vez siempre notifica); si no cambió, la corrida no genera evento nuevo aunque haya recalculado el score |
| `RECLAMO_INTERVENCION_DISPARADOR` (f) | Se lee al construir los listeners: un valor que no es `movilidad`, `reclamo` ni `ambos` frena el arranque en vez de descartar cada evento. El cierre por `ReclamoActualizado` no depende de esta variable. Nunca hay dos intervenciones por reclamo: `findByCausa` más el índice único de V29, también si los dos listeners procesan el mismo reclamo a la vez (el consumer procesa particiones en paralelo) |
| Advisory lock de la alerta (g) | Confirmación y finalización llegan por tópicos distintos y se pueden procesar a la vez. Las dos transacciones toman `pg_advisory_xact_lock` sobre el grupo de la alerta: la finalización gana aunque llegue antes, porque deja la marca de baja que la confirmación tardía consulta |
| Suba de prioridad (g) | Se mide una sola vez, al crear la emergencia, con la coordenada en memoria (no se guarda en claro). No sube las `PREVENTIVA` ni las que ya existían cuando empezó la alerta. `EmergenciaCreada` y `EmergenciaActualizada` publican la prioridad original; el vínculo saldría como `EmergenciaVinculadaAContextoZona`, hoy apagado en producción (`EVENTO_VINCULO_CONTEXTO_ENABLED=false`) |
| `detectGroups` (secuencia d) | Cae a `RuleBasedGrouper` **solo** ante una excepción de `DbscanGrouper` (falla técnica, ej. dataset no es un Array); un resultado vacío de DBSCAN es una respuesta válida y no dispara el fallback. Si el fallback también falla, la excepción se propaga sin capturar (PR #51, verificado en producción el 23/09) |

## Fuente en el código

- Front (`Frontend`): `app/(citizen)/inicio/InicioClient.js`, `app/lib/sosController.js`, `app/lib/api.js`, `app/lib/geocoding.js`, `lib/geocode-server.js`, `lib/backend-fetch.js`, `app/api/backend/[...path]/route.js`, `app/api/geocode/route.js`, `app/components/DispatcherView.js`, `app/(citizen)/mis-alertas/[id]/page.js`
- Back (`emergencias-backend`): `src/controllers/panic-button.controller.js` (`normalizeAddress`), `src/controllers/emergency.controller.js` (`advanceOperationalStatus`), `src/repositories/emergency.repository.js`, `src/security/location-crypto.js`, `src/services/outbox-publisher.js`, `src/services/kafka.service.js`, `src/services/emergency-events.js`
- Consumo (secuencia e): `src/listeners/event-listener.js`, `src/listeners/event-decoder.js`, `src/listeners/outcome-factory.js`, `src/listeners/cobertura-preventiva/`, `src/repositories/eventos-procesados.repository.js`
- Caso ciclovía (secuencia f): `src/listeners/reclamo-intervencion/disparador.js`, `reclamo-creado/`, `emergencia-solicitada/`, `reclamo-actualizado/` y `handlers/` (`crear-intervencion.handler.js`, `cerrar-intervencion.handler.js`), `db/migrations/V29__transito_y_emergencia_por_reclamo.sql`
- Alerta climática (secuencia g): `src/listeners/alerta-climatica/` (reglas y `handlers/`), `src/domain/alerta-climatica.js`, `src/repositories/contexto-zona.repository.js`, `src/repositories/emergency.repository.js` (`linkZoneContexts`, `ZONE_CONTEXT_JOIN_SQL`), `src/domain/severity.js` (`dispatchPriority`), `src/controllers/contexto-zona.controller.js`
- Motor de incidentes (secuencia d): `src/services/incident-detection-job.js` (`withDetectionLock`, `DETECTION_LOCK_KEY`), `src/domain/incident-detector.js`, `src/domain/incident-detection-strategy.js` (`detectGroups`), `src/domain/dbscan-grouper.js`, `src/domain/rule-based-grouper.js`, `src/domain/risk-engine.js`, `src/repositories/incident.repository.js` (`applyScoringDecision`)
