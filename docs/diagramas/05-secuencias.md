# Secuencias

Para qué sirve: mostrar paso a paso los tres flujos que se muestran en la demo del Hito 1, con
los nombres reales de funciones/archivos de front y back, para que sirvan de guion de demo y de
referencia de debugging.

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

## b) Dispatcher: listado, validar, asignar oficial, cerrar

```mermaid
sequenceDiagram
    actor Dispatcher
    participant Front as Front (DispatcherView)
    participant BFF as BFF (/api/backend/*)
    participant Back as Backend (/api/emergencies, /api/officers)
    participant DB as Neon Postgres

    loop cada 5000ms (POLLING_INTERVAL_MS)
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
    Back->>DB: BEGIN, UPDATE status, INSERT history, INSERT outbox (EmergenciaEstadoActualizado), COMMIT
    Back-->>Front: 200 { data } (vía BFF)

    Dispatcher->>Front: abre modal, elige oficial disponible
    Front->>BFF: PATCH /api/backend/api/emergencies/:id/assign { officerId }
    BFF->>Back: PATCH /api/emergencies/:id/assign (Bearer dispatcher)
    Back->>Back: assertTransition(VALIDATED, DISPATCHED)
    Back->>DB: BEGIN, SELECT officer FOR UPDATE, verifica status=disponible
    Back->>DB: UPDATE emergencies (status=DISPATCHED, assigned_officer_id), UPDATE officers (status=ocupado)
    Back->>DB: INSERT history, INSERT outbox (EmergenciaEstadoActualizado, reason="Assigned officer X"), COMMIT
    Back-->>Front: 200 { data, assignedOfficer } (vía BFF)

    Note over Dispatcher,Back: RESOLVED llega hoy sin endpoint propio (ver 04-maquina-de-estados.md)

    Dispatcher->>Front: click "Cerrar" (emergencia en RESOLVED)
    Front->>BFF: PATCH /api/backend/api/emergencies/:id/close
    BFF->>Back: PATCH /api/emergencies/:id/close (Bearer dispatcher)
    Back->>Back: assertTransition(RESOLVED, CLOSED)
    Back->>DB: BEGIN, UPDATE status=CLOSED, closed_at=now(), INSERT history, INSERT outbox (EmergenciaCerrada), COMMIT
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
    participant Kafka as Kafka (KAFKA_ENABLED)

    Ciudadano->>Front: confirma "Cancelar asistencia" (motivo opcional)
    Front->>BFF: PATCH /api/backend/api/emergencies/:id/cancel { reason }
    BFF->>Back: PATCH /api/emergencies/:id/cancel (Bearer citizen)
    Back->>Back: canCancelEmergency(user, emergency) — solo dueño
    Back->>Back: assertTransition(status, CANCELLED)
    Back->>DB: BEGIN, UPDATE status=CANCELLED, libera oficial si estaba asignado
    Back->>DB: INSERT history, INSERT outbox_events (status=PENDING, payload=EmergenciaEstadoActualizado), COMMIT
    Back-->>Front: 200 { data } (vía BFF)

    loop runOnce() cada intervalMs (default 5000ms)
        alt kafkaService.isEnabled() === true
            Pub->>DB: claimBatch() — UPDATE ... SET PROCESSING FOR UPDATE SKIP LOCKED LIMIT 50
            DB-->>Pub: lote de eventos reclamados
            loop por evento del lote
                Pub->>Kafka: producer.send(topic, payload)
                alt envío OK
                    Kafka-->>Pub: ack
                    Pub->>DB: markPublished(id) — status=PUBLISHED
                else falla o Kafka no conectado
                    Pub->>DB: markFailed(id, attempts) — backoff exponencial hasta OUTBOX_MAX_ATTEMPTS, luego FAILED
                end
            end
        else kafkaService.isEnabled() === false (Render prod hoy: KAFKA_ENABLED=false)
            Note over Pub,Kafka: no se llama claimBatch(): los eventos quedan PENDING indefinidamente
        end
        Pub->>DB: purgePublished() — borra PUBLISHED con más de OUTBOX_PUBLISHED_RETENTION_HOURS (168h)
    end
```

## Leyenda

| Elemento | Notas |
|---|---|
| BFF | Next.js del repo `Frontend`, corre server-side en Render; guarda el JWT en cookie `httpOnly` (`citypass_session`) y nunca lo expone al browser |
| `fetchBackend` | Reintenta 502/503/504 hasta 6 veces (~24s) porque Render (free) duerme el backend tras 15 min sin tráfico |
| Outbox transaccional | El `INSERT` en `emergencies`/`emergency_status_history` y el `INSERT` en `outbox_events` van en la **misma transacción**: si Kafka está caído, la emergencia igual queda persistida |
| `KAFKA_ENABLED=false` | Configurado así en `render.yaml` de producción hoy: el flujo (c) nunca llega a la rama que publica de verdad; los eventos se acumulan `PENDING` |

## Fuente en el código

- Front (`Frontend`): `app/(citizen)/inicio/InicioClient.js`, `app/lib/sosController.js`, `app/lib/api.js`, `app/lib/geocoding.js`, `lib/geocode-server.js`, `lib/backend-fetch.js`, `app/api/backend/[...path]/route.js`, `app/api/geocode/route.js`, `app/components/DispatcherView.js`, `app/(citizen)/mis-alertas/[id]/page.js`
- Back (`emergencias-backend`): `src/controllers/panic-button.controller.js`, `src/controllers/emergency.controller.js`, `src/repositories/emergency.repository.js`, `src/services/outbox-publisher.js`, `src/services/kafka.service.js`, `src/services/emergency-events.js`
