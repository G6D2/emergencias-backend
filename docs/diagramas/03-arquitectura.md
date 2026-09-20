# Arquitectura

Para qué sirve: ubicar el módulo de Emergencias dentro de CityPass+ (estilo C4 — nivel de
contenedores) y después abrir el backend en sus componentes internos.

## Contenedores

```mermaid
flowchart TB
    ciudadano(["Ciudadano / Dispatcher (browser)"]):::actor

    subgraph rfe["Render · Frontend"]
        bff["Next.js 16 (BFF)<br/>/api/auth/*, /api/backend/[...path], /api/geocode"]
    end

    subgraph rbe["Render · Backend"]
        api["Express API<br/>/api/*, /auth/dev/* (solo AUTH_MODE=local)"]
    end

    neon[("Neon Postgres<br/>(pooled, sslmode=require)")]

    subgraph edaGroup["Bus de eventos"]
        kafka["Kafka<br/>KAFKA_ENABLED=false en prod hoy"]:::planned
    end

    idp["IdP Grupo 2<br/>(previsto, AUTH_MODE=idp)"]:::planned

    subgraph geo["Geocodificación externa"]
        bdc["BigDataCloud<br/>(primario)"]
        nom["Nominatim<br/>(respaldo, 1 req/s)"]
    end

    subgraph gha["GitHub Actions"]
        ci["CI: lint + tests + cobertura 80% + Sonar"]
        cd["CD: migrate (Flyway) + deploy hook"]
        kw["Keep-warm (cron + job in-process)"]
    end

    sonar["SonarCloud<br/>(analisis estatico, opcional)"]:::optional

    backup["Stack de backup en otra cuenta Render<br/>contra la misma Neon"]:::unverified

    ciudadano -->|HTTPS| bff
    bff -->|"Bearer JWT (cookie httpOnly server-side) + retry 502/503/504"| api
    api -->|"pg pool, DB_POOL_MAX"| neon
    api -.->|"outbox -> producer.send (deshabilitado en prod)"| kafka
    api -.->|"verify RS256 via JWKS (previsto)"| idp
    bff -->|"GET reverse-geocode"| bdc
    bff -.->|"respaldo si BigDataCloud falla"| nom
    ci --> cd
    cd -->|"npm run migrate"| neon
    cd -->|"deploy hook"| rbe
    cd -.->|"deploy hook (repo Frontend)"| rfe
    kw -->|"GET /health, GET /api/warmup"| api
    kw -.-> rfe
    ci -.-> sonar
    backup -.->|"no confirmado en el repo, ver nota"| neon

    classDef actor fill:#e7f5ff,stroke:#1971c2,color:#0b3d91,stroke-width:1.5px;
    classDef planned fill:#f1f3f5,stroke:#adb5bd,color:#495057,stroke-width:1px,stroke-dasharray: 4 3;
    classDef optional fill:#fff3bf,stroke:#e8a33d,color:#5c3d00,stroke-width:1px;
    classDef unverified fill:#ffe3e3,stroke:#e03131,color:#7d1a1a,stroke-width:1px,stroke-dasharray: 2 2;
```

> **Nota sobre el stack de backup:** no se encontró en `emergencias-backend`, `Frontend` ni
> `ADRs` ningún workflow, `render.yaml` o mención de un segundo despliegue de respaldo en otra
> cuenta de Render. Se incluye el nodo porque la consigna de este documento lo pide, pero queda
> marcado como **no verificado en el código** — ver la sección de inconsistencias en el resumen
> de esta tarea.

## Componentes internos del backend

```mermaid
flowchart TB
    routes["routes<br/>panic-button, emergencies, officer, user, outbox, dev-auth"]
    auth["auth<br/>authenticate, authorize, jwt-verifier, groups, setup"]
    controllers["controllers<br/>panic-button, emergency, officer, user"]
    domain["domain<br/>emergency-status, emergency-type, severity"]
    repositories["repositories<br/>emergency, officer"]
    services["services<br/>emergency-events, kafka.service, outbox-publisher"]
    security["security<br/>location-crypto, location-retention, cors, rate-limit, secure-log, security-headers"]
    jobs["jobs / procesos en background<br/>OutboxPublisher.start(), location-retention, keep-warm"]
    db[("Neon Postgres")]
    kafkaC["Kafka (KafkaService, deshabilitado en prod)"]:::planned

    routes --> auth
    routes --> controllers
    controllers --> domain
    controllers --> repositories
    controllers --> services
    repositories --> security
    repositories --> db
    services --> security
    jobs --> repositories
    jobs --> services
    services --> kafkaC

    classDef planned fill:#f1f3f5,stroke:#adb5bd,color:#495057,stroke-width:1px,stroke-dasharray: 4 3;
```

## Leyenda

| Elemento | Estado |
|---|---|
| Línea sólida | Conexión activa hoy en el ambiente productivo |
| Línea punteada | Deshabilitado, previsto o de respaldo (no es el camino feliz actual) |
| `Kafka` | El código de producer existe (`src/services/kafka.service.js`) pero `render.yaml` fija `KAFKA_ENABLED=false`: los eventos quedan en `outbox_events` sin publicarse (ver `05-secuencias.md`) |
| `IdP Grupo 2` | Previsto: hoy corre `AUTH_MODE=local` (JWT propio con el mismo contrato de claims que usaría el IdP real, ver `src/auth/setup.js`) |
| SonarCloud | Corre solo si existe el secret `SONAR_TOKEN` (repo privado); `continue-on-error: true`, no bloquea el pipeline |
| Stack de backup | Incluido por la consigna de este documento; no se encontró evidencia en el repositorio (ver nota arriba) |

## Fuente en el código

- `src/app.js` (montaje de rutas y middlewares), `src/index.js` (composition root)
- `src/routes/*.js`, `src/controllers/*.js`, `src/domain/*.js`, `src/repositories/*.js`, `src/services/*.js`, `src/security/*.js`, `src/auth/*.js`
- `render.yaml` (backend), `Frontend/render.yaml`, `Frontend/app/api/backend/[...path]/route.js`, `Frontend/app/api/geocode/route.js`, `Frontend/lib/geocode-server.js`
- `.github/workflows/ci.yml`, `.github/workflows/cd.yml`, `.github/workflows/keep-warm.yml` (backend) y sus equivalentes en `Frontend/.github/workflows/`
- `sonar-project.properties` (backend y frontend)
