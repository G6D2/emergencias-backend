# Despliegue

Para qué sirve: mostrar dónde corre cada pieza en producción y qué variables de entorno usa
cada una (sin valores — ver `.env.example` y `render.yaml` para el detalle completo).

```mermaid
flowchart TB
    subgraph renderAccount["Cuenta de Render (primaria)"]
        direction TB
        feNode["emergencias-frontend<br/>(Next.js, plan free, region oregon)"]
        beNode["emergencias-backend<br/>(Docker: Express + listeners Kafka, plan free, region oregon)"]
    end

    subgraph renderBackup["Render — cuenta de backup"]
        direction TB
        backupNode["Backend backup<br/>(activate-backup.yml, manual)"]:::backup
    end

    neonNode[("Neon Postgres<br/>(único proyecto, pooled)")]
    busNode["Bus del Grupo 1<br/>Kafka SASL_SSL + schema registry"]
    loginNode["Login Federado Grupo 2<br/>(token de servicio)"]

    subgraph githubOrg["GitHub — G6D2"]
        direction TB
        repoBack["emergencias-backend"]
        repoFront["Frontend"]
        actionsNode["GitHub Actions<br/>(CI, CD, keep-warm, activate-backup)"]
    end

    sonarNode["SonarCloud<br/>(org g6d2, activo en los dos repos)"]

    feNode -->|"API_URL"| beNode
    beNode -->|"DATABASE_URL"| neonNode
    busNode -->|"KAFKA_BROKER, EDA_SCHEMA_REGISTRY_URL (solo consumo)"| beNode
    beNode -->|"EDA_OAUTH_CLIENT_SECRET"| loginNode
    backupNode -.->|"contra la misma Neon (config del servicio backup fuera de este repo)"| neonNode
    repoBack --> actionsNode
    repoFront --> actionsNode
    actionsNode -->|"deploy hook"| feNode
    actionsNode -->|"deploy hook + migrate"| beNode
    actionsNode -.->|"workflow_dispatch manual"| backupNode
    actionsNode -.-> sonarNode

    classDef backup fill:#e5dbff,stroke:#7048e8,color:#3c1361,stroke-width:1px,stroke-dasharray: 3 2;
```

## Variables de entorno relevantes (sin valores)

### `emergencias-backend` (`render.yaml` / `.env.example`)

| Variable | Para qué |
|---|---|
| `NODE_ENV` | `production` fuerza HTTPS/HSTS, endurece CORS y dev login, y con `AUTH_MODE=local` exige `ALLOW_LOCAL_AUTH`. Producción hoy **no** corre con `production` (no manda HSTS) |
| `DATABASE_URL` | Connection string pooled de Neon, `sslmode=require` |
| `DATABASE_SSL`, `DATABASE_SSL_VERIFY`, `DATABASE_SSL_CA` | SSL del pool (por default cifra sin verificar el certificado) |
| `DB_POOL_MAX` | Tope de conexiones del pool `pg` |
| `KAFKA_ENABLED`, `KAFKA_BROKER`, `KAFKA_SSL`, `KAFKA_CLIENT_ID` | Conexión al bus del Grupo 1 (en producción: prendido, SSL, `test.citypass.mrfranco.net.ar:9092`) |
| `KAFKA_CONSUMER_ENABLED`, `KAFKA_CONSUMER_GROUP_PREFIX`, `EDA_TOPIC_EVENTO_PUBLICADO`, `EDA_TOPIC_EVENTO_CANCELADO`, `UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA` | Listeners de cobertura preventiva (en producción: prendidos) |
| `EDA_SCHEMA_REGISTRY_URL` (+ `_USERNAME`/`_PASSWORD` opcionales) | Registry del gateway para decodificar Avro |
| `EDA_OAUTH_TOKEN_URL`, `EDA_OAUTH_CLIENT_ID`, `EDA_OAUTH_CLIENT_SECRET` | Token client-credentials del Login Federado para el broker (SASL/OAUTHBEARER) y el registry. Solo el secreto se setea en producción |
| `OUTBOX_PUBLISHER_ENABLED`, `OUTBOX_PUBLISH_SINCE`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_MAX_BACKOFF_MS`, `OUTBOX_PUBLISHED_RETENTION_HOURS` | Publisher del outbox (en producción: apagado) |
| `TOPIC_PANIC_BUTTON`, `TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO`, `TOPIC_EMERGENCIA_PRIORIZADA` | Tópicos de `EmergenciaCreada`, `EmergenciaActualizada` y `EmergenciaPriorizada` |
| `LOCATION_ENCRYPTION_KEY` / `LOCATION_ENCRYPTION_KEYS` / `LOCATION_ENCRYPTION_KEY_ID` | Cifrado AES-256-GCM de ubicación (obligatoria, el server no arranca sin ella) |
| `LOCATION_RETENTION_HOURS`, `LOCATION_RETENTION_ENABLED` | Job de anonimización |
| `CORS_ALLOWED_ORIGINS` | Origins permitidos (sin ella, producción cae a un default con warning) |
| `RATE_LIMIT_ENABLED` | Apaga el rate limit (login, panic-button) |
| `KEEP_WARM_ENABLED`, `KEEP_WARM_URLS`, `KEEP_WARM_WINDOWS`, `KEEP_WARM_TZ`, `KEEP_WARM_INTERVAL_MS` | Job in-process que evita el sleep de Render (free) |
| `AUTH_MODE`, `ALLOW_LOCAL_AUTH` | `local` (JWT propio) hoy; `idp` cuando conecte el Grupo 2 |
| `DEV_LOGIN_STRICT` | `true` en producción: `/auth/dev/login` solo emite tokens para los subs demo |
| `IDP_ISSUER`, `IDP_AUDIENCE`, `IDP_MODULE`, `IDP_CLOCK_TOLERANCE_SECONDS`, `IDP_JWKS_URI` | Claims/validación esperados del IdP real (previsto) |
| `LOCAL_TOKEN_TTL_SECONDS`, `LOCAL_JWT_PRIVATE_KEY_PEM` | Solo `AUTH_MODE=local` |
| `FORCE_HTTPS` | Forzar HTTPS fuera de `production` |
| `CITIZEN_PII_RETENTION_*`, `INCIDENT_*`, `LOCATION_RETENTION_INTERVAL_MS` | Jobs de retención del perfil y de detección de incidentes (defaults del código en producción) |

La lista completa, con defaults y comentarios, está en `.env.example`.

### `Frontend` (`render.yaml`)

| Variable | Para qué |
|---|---|
| `NODE_ENV` | `production` |
| `API_URL` | URL pública del backend; la usan el BFF (`/api/backend/*`) y el login desde el servidor, nunca se expone al browser |
| `BACKEND_WARMUP_PATH` | Path de health-check que dispara `/api/warmup` |

### Secrets de CI/CD (GitHub Actions, ambos repos)

| Secret | Para qué |
|---|---|
| `DATABASE_URL` | CD del backend, para correr `npm run migrate` contra Neon |
| `RENDER_DEPLOY_HOOK_URL` | CD de ambos repos, dispara el redeploy en Render |
| `RENDER_DEPLOY_HOOK_URL_BACKUP` | `activate-backup.yml`, dispara el redeploy del backend backup en la otra cuenta de Render |
| `SONAR_TOKEN` | Análisis de SonarCloud; cargado en ambos repos (backend desde el inicio, `Frontend` desde el 21/09) |
| `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_TO` | Notificación por email si falla CI/CD |
| `GITHUB_TOKEN` | Comentario de cobertura en el PR (provisto automáticamente por Actions) |

### Variables de repo (no secretas) usadas por `activate-backup.yml`

| Variable | Para qué |
|---|---|
| `BACKUP_BACKEND_URL` | URL pública del backend backup, usada para el polling de `/health` post-deploy |

## Notas

- **Ambas apps duermen** en el plan free de Render tras 15 minutos sin tráfico (50-60s de
  arranque en frío). Por eso existen `keep-warm.yml` + `src/jobs/keep-warm.js` (backend) y
  `/api/warmup` (frontend) — ver `07-ci-cd.md`.
- El stack de backup en otra cuenta de Render **sí existe**: `.github/workflows/activate-backup.yml`
  (PR #38) lo confirma, con secret `RENDER_DEPLOY_HOOK_URL_BACKUP` y variable `BACKUP_BACKEND_URL`.
  Es manual (`workflow_dispatch`, sin cron ni failover automático) y no migra nada por sí solo.
  Que apunte contra la misma Neon que el primario es una decisión de configuración del servicio
  backup en el dashboard de Render — no vive en este repo, así que no se puede verificar línea
  por línea contra código, pero es la config que el equipo reporta estar usando.
- No hay object storage separado para adjuntos (fotos/evidencias): esas historias (HU-02 con
  foto, HU-09 observaciones) todavía no están implementadas.

## Fuente en el código

- `render.yaml` (backend: servicio Docker con `autoDeployTrigger: off`), `Frontend/render.yaml`
- `.env.example` (backend)
- `.github/workflows/*.yml` (backend y frontend), incluido `.github/workflows/activate-backup.yml`
- `src/jobs/keep-warm.js`, `Frontend/app/api/warmup/route.js`, `Frontend/app/components/BackendWarmup.js`
