# Arquitectura

Para qué sirve: ubicar el módulo de Emergencias dentro de CityPass+ (estilo C4 — nivel de
contenedores) y después abrir el backend en sus componentes internos.

## Contenedores

```mermaid
flowchart TB
    ciudadano(["Ciudadano / Dispatcher / Oficial (browser)"]):::actor

    subgraph rfe["Render · Frontend"]
        bff["Next.js 16 (BFF)<br/>/api/auth/*, /api/backend/[...path], /api/geocode"]
    end

    subgraph rbe["Render · Backend (Docker, plan free)"]
        api["Express API<br/>/api/*, /auth/* (AUTH_MODE=hybrid en producción)<br/>+ 8 listeners Kafka y OutboxPublisher en el mismo proceso"]
    end

    neon[("Neon Postgres<br/>(pooled, sslmode=require)")]

    subgraph edaGroup["Bus de eventos (Grupo 1)"]
        kafka["Kafka SASL_SSL<br/>test.citypass.mrfranco.net.ar:9092"]
        gateway["Event gateway (HTTP)<br/>POST /api/v1/event-types/{fqn}/events"]
        registry["Schema registry del gateway<br/>/api/v1"]
    end

    login["Login Federado Grupo 2<br/>token de servicio del bus"]
    idp["Login Federado Grupo 2 para el personal<br/>(AUTH_MODE=hybrid, en producción)"]

    subgraph geo["Geocodificación externa"]
        bdc["BigDataCloud<br/>(primario)"]
        nom["Nominatim<br/>(respaldo, 1 req/s)"]
    end

    subgraph gha["GitHub Actions"]
        ci["CI: lint + tests + cobertura (gate interno 80%, catedra pide 60%) + Sonar"]
        cd["CD: migrate (Flyway) + deploy hook"]
        kw["Keep-warm (cron + job in-process)"]
    end

    sonar["SonarCloud<br/>(analisis estatico, activo en ambos repos)"]:::optional

    backup["Backend backup (otra cuenta Render)<br/>activate-backup.yml, manual"]:::backup

    ciudadano -->|HTTPS| bff
    bff -->|"Bearer JWT (cookie httpOnly server-side) + retry 502/503/504"| api
    api -->|"pg pool, DB_POOL_MAX"| neon
    kafka -->|"consume 8 tipos de evento:<br/>Espacios (EventoComunitarioPublicado, EventoCancelado, ActividadCreada, ReservaCreada),<br/>Movilidad (EmergenciaSolicitada, EmergenciaBicicleta),<br/>Reclamos (ReclamoCreado, ReclamoActualizado)<br/>+ alerta climática de Espacios (opt-in)"| api
    api -->|"decodifica Avro (Bearer)"| registry
    api -->|"client-credentials"| login
    api -->|"outbox -> GatewayPublisher (EDA_PUBLISHER_MODE=gateway):<br/>EmergenciaCreada, EmergenciaActualizada"| gateway
    gateway -->|"sella metadata y publica"| kafka
    api -->|"verify RS256 via JWKS (tokens del personal)"| idp
    bff -->|"GET reverse-geocode"| bdc
    bff -.->|"respaldo si BigDataCloud falla"| nom
    ci --> cd
    cd -->|"npm run migrate"| neon
    cd -->|"deploy hook"| rbe
    cd -.->|"deploy hook (repo Frontend)"| rfe
    kw -->|"GET /health, GET /api/warmup"| api
    kw -.-> rfe
    ci -.-> sonar
    backup -.->|"workflow_dispatch manual, deploy hook + espera /health"| neon

    classDef actor fill:#e7f5ff,stroke:#1971c2,color:#0b3d91,stroke-width:1.5px;
    classDef planned fill:#f1f3f5,stroke:#adb5bd,color:#495057,stroke-width:1px,stroke-dasharray: 4 3;
    classDef optional fill:#fff3bf,stroke:#e8a33d,color:#5c3d00,stroke-width:1px;
    classDef backup fill:#e5dbff,stroke:#7048e8,color:#3c1361,stroke-width:1px,stroke-dasharray: 3 2;
```

> **Nota sobre el stack de backup:** existe de verdad, a diferencia de lo que decía la versión
> anterior de este documento. `.github/workflows/activate-backup.yml` (mergeado en el PR #38) es
> un workflow manual (`workflow_dispatch`, sin cron ni trigger automático): dispara el deploy
> hook de un segundo servicio backend en otra cuenta de Render (secret
> `RENDER_DEPLOY_HOOK_URL_BACKUP`) y espera hasta 6 minutos a que su `/health` responda 200
> (variable de repo `BACKUP_BACKEND_URL`). Ni la URL del servicio backup ni su propio
> `DATABASE_URL` están versionados en este repo (se configuran en el dashboard de Render); que
> apunte a la misma Neon primaria es una decisión operativa del equipo, no algo que se pueda leer
> en este código — se documenta igual porque así lo confirmó quien armó el stack. No hay
> failover automático: alguien tiene que correr el workflow a mano.

## Componentes internos del backend

```mermaid
flowchart TB
    routes["routes<br/>panic-button, emergencies, officer, user, outbox, dev-auth, incidents, citizen-profile"]
    auth["auth<br/>authenticate, authorize, jwt-verifier, groups, dev-login-policy, setup"]
    controllers["controllers<br/>panic-button, emergency, officer, user, incident, auth, citizen-profile"]
    domain["domain<br/>emergency-status, emergency-type, severity"]
    incidentDomain["domain · motor de incidentes<br/>incident-detector, risk-engine"]:::incident
    strategy["incident-detection-strategy<br/>detectGroups(candidates, options, {primary, fallback})"]:::incident
    dbscanGrouper["dbscan-grouper<br/>(estrategia primaria, DBSCAN vía density-clustering)"]:::incident
    ruleGrouper["rule-based-grouper<br/>(estrategia fallback, Union-Find + Haversine)"]:::incident
    repositories["repositories<br/>emergency, officer, incident, citizen-profile, auth-user,<br/>eventos-procesados, contexto-zona"]
    services["services<br/>emergency-events, kafka.service, outbox-publisher,<br/>gateway-publisher, eda-auth-client"]
    listeners["listeners<br/>EventConsumer (un solo consumer) + cobertura-preventiva +<br/>reclamo-intervencion + movilidad-bicicleta<br/>(reglas por evento, OutcomeFactory con dedup)"]:::consumer
    detectionJob["incident-detection-job<br/>cada 60s, pg_try_advisory_lock"]:::incident
    security["security<br/>location-crypto, location-retention, cors, rate-limit, secure-log, security-headers"]
    jobs["jobs / procesos en background<br/>OutboxPublisher (prendido en prod, publica por el gateway),<br/>location-retention, citizen-profile-retention,<br/>emergency-expiration-job, incident-detection-job, keep-warm"]
    db[("Neon Postgres")]
    kafkaC["Kafka (KafkaService: consumer; el producer solo se usa en local)"]
    gatewayC["Event gateway del Grupo 1 (HTTP)"]

    routes --> auth
    routes --> controllers
    controllers --> domain
    controllers --> repositories
    controllers --> services
    repositories --> security
    repositories --> db
    services --> security
    jobs --> domain
    jobs --> repositories
    jobs --> services
    services -->|"consumer (SASL/OAUTHBEARER)"| kafkaC
    services -->|"GatewayPublisher: EmergenciaCreada / EmergenciaActualizada"| gatewayC
    kafkaC -->|"mensajes de Espacios, Movilidad y Reclamos"| listeners
    listeners -->|"create / updateStatus en la transacción del OutcomeFactory"| repositories

    detectionJob --> incidentDomain
    incidentDomain --> strategy
    strategy --> dbscanGrouper
    strategy -.->|"fallback solo si primary lanza excepción"| ruleGrouper
    detectionJob -->|"findRecentByType"| repositories
    detectionJob -->|"create / addMember / applyScoringDecision"| repositories
    detectionJob -.->|"pg_try_advisory_lock(875312047)"| db

    classDef planned fill:#f1f3f5,stroke:#adb5bd,color:#495057,stroke-width:1px,stroke-dasharray: 4 3;
    classDef incident fill:#d3f9d8,stroke:#2f9e44,color:#1b4332,stroke-width:1.5px;
    classDef consumer fill:#e7f5ff,stroke:#1971c2,color:#0b3d91,stroke-width:1.5px;
```

> **Sobre `IncidentDetectionStrategy`:** implementada en el PR #51 (tarea #61, ADR-002
> "IncidentDetectionStrategy"), verificada en producción el 23/09. `src/domain/incident-detector.js`
> ya no importa `rule-based-grouper.js` directo: llama a `detectGroups(candidates, options, {
> primary, fallback })` de `src/domain/incident-detection-strategy.js`, con `DbscanGrouper`
> (`src/domain/dbscan-grouper.js`, librería `density-clustering`, mismo `haversineDistanceMeters`
> y `minPts = INCIDENT_MIN_CITIZENS` con filtro posterior de ciudadanos únicos) como estrategia
> primaria y `RuleBasedGrouper` como fallback determinístico. `detectGroups` cae a `fallback`
> **solo** ante una excepción de `primary` — nunca porque el resultado sea un array vacío, que es
> una respuesta válida. La estrategia que corrió queda en `algorithmVersion` (`dbscan-v1` o
> `rule-based-v1`). Los parámetros están calibrados con un dataset sintético en
> [`../ml/calibracion-dbscan.md`](../ml/calibracion-dbscan.md) (`scripts/calibrar-dbscan.js`): los
> defaults actuales quedan; falta contrastarlos con casos reales.

## Leyenda

| Elemento | Estado |
|---|---|
| Línea sólida | Conexión activa hoy en el ambiente productivo |
| Línea punteada | Deshabilitado, previsto o de respaldo (no es el camino feliz actual) |
| `Kafka` | Conectado al bus del Grupo 1 (`KAFKA_ENABLED=true`, SASL/OAUTHBEARER + SSL) para consumir: ocho listeners sobre un único consumer (`EventConsumer`) leen eventos de Espacios (`EventoComunitarioPublicado`, `EventoCancelado`, `ActividadCreada`, `ReservaCreada`), Movilidad (`EmergenciaSolicitada`, `EmergenciaBicicleta`) y Reclamos (`ReclamoCreado`, `ReclamoActualizado`). Los ocho figuran `running` en `GET /health` de producción (verificado el 16/11/2026). Los dos de alerta climática (`CriticidadClimaticaConfirmada` y `CriticidadClimaticaFinalizada`) son opt-in y figuran `disabled` hasta cargar `EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA` y `_FINALIZADA`. Los eventos propios salen por HTTP al gateway (`EDA_PUBLISHER_MODE=gateway`, `OUTBOX_PUBLISHER_ENABLED=true`), no por el producer de Kafka (ver `06-eventos.md`) |
| `Login Federado` (token de servicio) | Token client-credentials del bus y del schema registry (`EDA_OAUTH_*`, `src/services/eda-auth-client.js`) |
| `IdP Grupo 2` | En uso desde el 12/11/2026: producción corre `AUTH_MODE=hybrid`. Los tokens del personal se validan contra el JWKS del Login Federado y los de ciudadanos y atajos de demo contra la clave local, según el `iss` (ver `src/auth/setup.js` y `src/auth/hybrid-verifier.js`) |
| Render free | El backend duerme sin tráfico; mientras duerme no consume. Al despertar, el consumer group sigue desde su último offset confirmado |
| SonarCloud | Corre en los dos repos (secret `SONAR_TOKEN` cargado en backend y, desde el 21/09, en `Frontend`); sigue siendo `continue-on-error: true`, no bloquea el pipeline |
| Stack de backup | Confirmado en el código por `.github/workflows/activate-backup.yml` (PR #38); manual, sin failover automático (ver nota arriba) |
| `IncidentDetectionStrategy` | Implementada desde el PR #51 (verificado en producción el 23/09): `incident-detector.js` llama a `detectGroups()`, que corre `DbscanGrouper` como primaria y cae a `RuleBasedGrouper` solo ante una excepción de DBSCAN. Ver nota arriba |

## Fuente en el código

- `src/app.js` (montaje de rutas y middlewares), `src/index.js` (composition root, arranca `startIncidentDetectionJob`)
- `src/routes/*.js` (incluido `incidents.routes.js`), `src/controllers/*.js` (incluido `incident.controller.js`), `src/domain/*.js` (incluidos `rule-based-grouper.js`, `dbscan-grouper.js`, `incident-detection-strategy.js`, `risk-engine.js`, `incident-detector.js`), `src/repositories/*.js` (incluido `incident.repository.js`), `src/services/*.js` (incluido `incident-detection-job.js`), `src/security/*.js`, `src/auth/*.js`, `scripts/demo-dbscan.js` (dataset sintético de demo)
- `src/listeners/` (`event-consumer.js`, `cobertura-preventiva/`, `reclamo-intervencion/`, `movilidad-bicicleta/`), `src/services/eda-auth-client.js`, `src/services/gateway-publisher.js`
- `render.yaml` (backend), `Frontend/render.yaml`, `Frontend/app/api/backend/[...path]/route.js`, `Frontend/app/api/geocode/route.js`, `Frontend/lib/geocode-server.js`
- `.github/workflows/ci.yml`, `.github/workflows/cd.yml`, `.github/workflows/keep-warm.yml`, `.github/workflows/activate-backup.yml` (backend) y sus equivalentes en `Frontend/.github/workflows/`
- `sonar-project.properties` (backend y frontend)
