# Emergencias Backend

**CityPass+ - Módulo de Emergencias y Seguridad**

## Descripción

Backend para el módulo de Emergencias y Seguridad de CityPass+. Gestiona botones de pánico, alertas críticas y cambios de estado de emergencias.

## Caso de Uso 2: Botón de Pánico

**Objetivo:** Permitir que ciudadanos activen un botón de pánico que genere una emergencia crítica.

### Flujo
1. Usuario activa botón de pánico en la app mobile/web
2. Sistema persiste la emergencia en PostgreSQL (`PENDING`)
3. Evento se publica en Kafka (`emergencias.boton-panico`)
4. Operadores pueden visualizar la emergencia en tiempo real

---

## Inicio Rápido

### Requisitos
- Node.js 20+
- Docker & Docker Compose (para **Kafka**; Postgres puede ser Neon o Docker)

### 1. Variables de entorno

```bash
cp .env.example .env
```

Editá `.env` según cómo quieras la base:

| Opción | `DATABASE_URL` | `DATABASE_SSL` | Docker que necesitás |
|--------|----------------|----------------|----------------------|
| **Neon** (recomendado para equipo / CD) | connection string de Neon | `true` | solo Kafka + Zookeeper |
| **Postgres local** | `postgresql://postgres:postgres@localhost:5434/emergencias_dev` | `false` | Postgres + Kafka + Zookeeper |

### 2a. Con Neon (Kafka en Docker, DB en la nube)

```bash
# Pegá la URL de Neon en .env (DATABASE_SSL=true)
docker-compose up -d kafka zookeeper
npm install
npm run migrate
npm run dev
```

**Sin Docker (backend en el host):**

```bash
# npm install local es obligatorio aunque ya exista node_modules/:
# si las dependencias se instalaron desde el contenedor (Linux), en el host faltan o no sirven.
npm install

# En .env: apuntar Kafka al listener del host (NO al de Docker, ver sección Kafka más abajo)
#   KAFKA_BROKER=localhost:9092
# Si 3000/3001 están ocupados, elegir otro puerto:
#   PORT=4000

# Levantar solo la infraestructura de Kafka en Docker
docker compose up -d kafka

npm run dev
```

### 2b. Todo local (Postgres + Kafka en Docker)

```bash
# En .env usá la URL localhost y DATABASE_SSL=false (está comentada en .env.example)
docker-compose up -d postgres kafka zookeeper
npm install
npm run migrate
npm run dev
```

### 2c. Stack completo en contenedores

```bash
docker-compose up
# backend en http://localhost:3001 — igual necesitás DATABASE_URL válida
# (Neon o el servicio postgres del compose)
```

### Verificar que funciona

```bash
# Reemplazar 3000 por el PORT configurado en .env
curl http://localhost:3000/health
```

Documentación OpenAPI (Swagger UI): [http://localhost:3000/api-docs](http://localhost:3000/api-docs)  
Spec JSON: [http://localhost:3000/api-docs.json](http://localhost:3000/api-docs.json)

### Postman

Importá en Postman:
- Colección: [`postman/Emergencias-Backend.postman_collection.json`](postman/Emergencias-Backend.postman_collection.json)
- Environment: [`postman/Emergencias-Backend-Local.postman_environment.json`](postman/Emergencias-Backend-Local.postman_environment.json)

Pegá el `access_token` en `accessToken`. En la primera entrega usá **POST /auth/dev/login** (colección incluida) para obtenerlo sin IdP.

---

## Autenticación (JWT CityPass+)

Los endpoints bajo `/api/*` exigen `Authorization: Bearer <access_token>`.

### Primera entrega — sin IdP (`AUTH_MODE=local`, default)

Funcionás solos con JWT local que **respeta el mismo contrato** que CityPass+ (claims, RS256, `verify()`).

1. `POST /auth/register` — alta email+password (tabla `auth_users`, bcrypt)
2. `POST /auth/login` — login email+password → `access_token`
3. `POST /auth/dev/login` — token inventando `sub` (tests / atajos demo)
4. Mandá ese token en `Authorization: Bearer …` al resto de la API

Cuentas demo seed (V16, password `abracadabra`): `juanpanico@gmail.com` (antipánico) y `luciatranquila@gmail.com`.

**Ejemplo register/login:**
```json
{ "email": "nuevo@example.com", "password": "secreto12", "preferred_username": "nuevo" }
```

**Ejemplo dev login:**
```json
{
  "sub": "U000042",
  "preferred_username": "jperez",
  "groups": ["citizen"]
}
```

**Respuesta:**
```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "Bearer",
  "expires_in": 900
}
```

| Variable | Rol |
|----------|-----|
| `AUTH_MODE` | `local` (default) o `idp` |
| `IDP_ISSUER` / `IDP_AUDIENCE` | Claims del token (defaults alineados al contrato) |
| `LOCAL_TOKEN_TTL_SECONDS` | Vida del token local (default 900) |
| `LOCAL_JWT_PRIVATE_KEY_PEM` | Opcional: misma clave entre reinicios |

`AUTH_MODE=local` **no arranca en producción** salvo staging pre-IdP (ver abajo).

### Deploy (Render / staging) sin Grupo 2

Sí podés deployar y probar la API antes del IdP. En el dashboard de Render (o secrets del CD) configurá:

```env
AUTH_MODE=local
ALLOW_LOCAL_AUTH=true
CORS_ALLOWED_ORIGINS=https://frontend-krds.onrender.com
```

El server arranca con `NODE_ENV=production` y expone `POST /auth/dev/login` para obtener tokens.  
**Sacá `ALLOW_LOCAL_AUTH` cuando pasen a IdP real** — es solo para la primera entrega.

En producción, si `CORS_ALLOWED_ORIGINS` no está seteada, el server igual arranca: cae al frontend de Render (`https://frontend-krds.onrender.com`) y deja un `warn` en el log. Configurarla explícitamente evita depender de ese fallback.

### Keep-warm (Render plan free)

Render (free) duerme backend y frontend tras 15 min sin tráfico y tardan 50-60 s en despertar. Hay dos mecanismos, pensados para el horario de clase (jueves, hora Argentina) y no todo el mes (750 h gratis):

1. **Primer despertar**: el workflow `.github/workflows/keep-warm.yml` (cron de GitHub Actions, jueves 16:50 ART y luego cada 20 min hasta las 23:59 ART; también `Run workflow` manual). Los crons de GitHub son *best effort* — el 10/09 no corrió ninguna ejecución programada — así que no alcanza solo con eso.
2. **Mantenerse despierto**: el job in-process `src/jobs/keep-warm.js`. Mientras el backend está arriba, cada `KEEP_WARM_INTERVAL_MS` hace `GET` a cada URL de `KEEP_WARM_URLS` (su propia URL pública, que pasa por el edge de Render y cuenta como tráfico, y el `/api/warmup` del frontend), solo dentro de las ventanas de `KEEP_WARM_WINDOWS`. Timeout 60 s por URL; un ping fallido solo deja un `warn`.

| Variable | Rol |
|----------|-----|
| `KEEP_WARM_ENABLED` | `false` para desactivar el job (default: activo) |
| `KEEP_WARM_URLS` | URLs a pegar, separadas por coma. Vacío (default, dev) = no hace nada |
| `KEEP_WARM_WINDOWS` | Ventanas `DOW:HH:MM-HH:MM` separadas por coma (`DOW`: `lun,mar,mie,jue,vie,sab,dom` o `0`=dom … `6`=sab), o `always`. Default `jue:17:00-23:30` |
| `KEEP_WARM_TZ` | Zona IANA en la que se evalúan las ventanas (default `America/Argentina/Buenos_Aires`) |
| `KEEP_WARM_INTERVAL_MS` | Intervalo entre pasadas (default `480000` = 8 min) |

Producción (ya en `render.yaml`; si el servicio no usa Blueprint, setearlo en el dashboard de Render):

```env
KEEP_WARM_URLS=https://emergencias-backend-34go.onrender.com/health,https://frontend-krds.onrender.com/api/warmup
KEEP_WARM_WINDOWS=jue:17:00-23:30
```

Para una demo otro día: `KEEP_WARM_WINDOWS=mar:18:00-21:00,jue:17:00-23:30` (o `always` unos días) + `Run workflow` para el primer despertar.

### Integración con Grupo 2 — solo cambiar env

```env
AUTH_MODE=idp
IDP_ISSUER=https://idp.citypass.local
IDP_AUDIENCE=citypass-emergencias-api
IDP_JWKS_URI=https://idp.citypass.local/.well-known/jwks.json
IDP_CLOCK_TOLERANCE_SECONDS=60
```

Sin cambios de código: el middleware sigue validando RS256 + claims. El frontend pasa de `/auth/dev/login` al `POST /auth/login` real del IdP.

| Variable (idp) | Rol |
|----------|-----|
| `IDP_JWKS_URI` | JWKS público para verificar firma RS256 |

Validaciones: firma RS256 vía JWKS, `iss`, `aud` (lista), `exp`, `token_use: human`, `ver: 1`.

La identidad queda en `req.user` (`sub`, `groups`, `username`, `jti`, …).  
**No se confía en `userId` ni `actor` del body** — salen del claim `sub`.

Token ausente o inválido → **401**. Sin grupo o sin permiso → **403**.

### Autorización por `groups`

Grupo desconocido no otorga nada. Mapa actual del módulo:

| Grupo | Permisos |
|-------|----------|
| `citizen` | Activar pánico; ver y cancelar **solo sus** emergencias |
| `dispatcher` | Ver cualquier emergencia; validar; descartar; listar oficiales; asignar oficial |

| Endpoint | Grupo requerido | Regla extra |
|----------|-----------------|-------------|
| `GET /api/user` | autenticado | devuelve `sub`, `groups`, `username` del JWT |
| `POST /api/panic-button` | `citizen` | rate limit 5 req/min por IP |
| `GET /api/panic-button/:id` | `citizen` o `dispatcher` | citizen: solo `userId === sub` (404 si ajena) |
| `GET /api/emergencies` | `citizen` o `dispatcher` | citizen: solo las propias |
| `GET /api/emergencies/:id` | `citizen` o `dispatcher` | citizen: solo propias (404 si ajena) |
| `PATCH /api/emergencies/:id/validate` | `dispatcher` | PENDING → VALIDATED |
| `PATCH /api/emergencies/:id/discard` | `dispatcher` | PENDING → DISCARDED; motivo obligatorio |
| `PATCH /api/emergencies/:id/assign` | `dispatcher` | VALIDATED → DISPATCHED; oficial disponible |
| `GET /api/officers` | `dispatcher` | catálogo local (oficiales no se loguean acá) |
| `PATCH /api/emergencies/:id/cancel` | `citizen` | solo dueño (`userId === sub`) |

En dev login podés probar groups distintos:
```json
{ "sub": "U000042", "groups": ["citizen"] }
{ "sub": "U000999", "groups": ["dispatcher"] }
```

Token ausente o inválido → **401 Unauthorized**. `/health`, `/api-docs` y `/auth/dev/*` (solo local) son públicos.

---

## Seguridad de datos (prioridad alta)

### Ubicación cifrada en reposo
`latitude`/`longitude` **no se guardan en claro**. Se cifra con AES-256-GCM (`LOCATION_ENCRYPTION_KEY`, 32 bytes en base64) y se persiste en `location_encrypted`. Al leer, el repository desencripta solo para la respuesta HTTP autorizada.

Generar clave:
```bash
openssl rand -base64 32
```

Cada ciphertext lleva una cabecera con el id de la clave que lo cifró
(`ELC || version || keyId || iv || authTag || ct`), así que la clave se puede rotar
sin perder los datos ya guardados.

**Rotar la clave:**
1. Generar la clave nueva y publicar las dos en el keyring, dejando la vieja activa:
   `LOCATION_ENCRYPTION_KEYS=v1:<vieja>,v2:<nueva>` + `LOCATION_ENCRYPTION_KEY_ID=v1`.
2. Cambiar el activo a `v2`. Las filas nuevas se cifran con `v2`; las viejas se
   siguen leyendo con `v1`.
3. Cuando ya no queden filas con `v1` (con retención post-cierre, tras `LOCATION_RETENTION_HOURS`),
   sacar `v1` del keyring.

Las filas escritas antes de esta versión no tienen cabecera y se desencriptan
probando las claves del keyring, así que la migración no requiere backfill.

### Retención / minimización
Job en background (y `npm run security:anonymize-locations`) borra el ciphertext `LOCATION_RETENTION_HOURS` (default 72) **después de `closed_at`**. Emergencias abiertas (`closed_at` null) no se tocan. La fila sigue existiendo; `latitude`/`longitude` quedan `null` y `locationAnonymized: true`.

Si una fila fue cifrada con otra clave (por ejemplo, insertada desde un entorno local apuntando a la base compartida), el listado no falla: esa emergencia vuelve con `latitude`/`longitude` en `null` y `locationUnavailable: true`, y queda un `warn` en el log con su id. Para sanearlas: `npm run security:anonymize-undecryptable` (con `DATABASE_URL` y `LOCATION_ENCRYPTION_KEY` del entorno afectado).

### Logs seguros
No se loguean JWT ni coordenadas. Kafka loguea solo un resumen (`emergencyId`, `status`, `hasLocation`).

### HTTPS / headers
En `NODE_ENV=production`: HSTS + redirect a HTTPS (vía `X-Forwarded-Proto`, típico en Render). Headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, etc.

### Auditoría de lectura
Cada `GET /api/panic-button/:id` autorizado deja un registro en `emergency_access_audit` (`actor_sub`, `action`, timestamp).

| Variable | Rol |
|----------|-----|
| `LOCATION_ENCRYPTION_KEY` | AES-256 key (base64, 32 bytes) — **obligatoria** (salvo que se use `LOCATION_ENCRYPTION_KEYS`) |
| `LOCATION_ENCRYPTION_KEYS` | Keyring para rotar: `id:base64key,id2:base64key2` (opcional) |
| `LOCATION_ENCRYPTION_KEY_ID` | Id de la clave con la que se cifra (default: `1`, o la primera del keyring) |
| `LOCATION_RETENTION_HOURS` | Horas tras el cierre (`closed_at`) antes de anonimizar (default 72) |
| `LOCATION_RETENTION_ENABLED` | `false` para desactivar el job |
| `FORCE_HTTPS` | Forzar HTTPS aunque no sea production |
| `CORS_ALLOWED_ORIGINS` | Origins permitidos (coma-separados). Sin ella: `http://localhost:3001` fuera de producción; en producción exige la variable y si falta cae a `https://frontend-krds.onrender.com` con un warn en el log (nunca refleja el origin del request) |
| `DB_POOL_MAX` | Máximo de conexiones del pool de `pg` (default 10) |
| `RATE_LIMIT_ENABLED` | `false` apaga el rate limiting (default: activo) |

El health check reporta el estado de Kafka (`connected`/`disconnected`). Ojo: `connected` solo indica que el producer se conectó — ver la sección de Kafka para una trampa conocida al publicar desde el host.

### Rate limiting

`express-rate-limit`, activo por default (`RATE_LIMIT_ENABLED=false` lo apaga; útil en tests, que reusan la misma app/IP para muchos requests seguidos):

| Endpoint | Límite | Respuesta al exceder |
|----------|--------|-----------------------|
| `POST /auth/dev/login` | 10 req/min por IP | `429 { "error": "TooManyRequests", "message": "..." }` |
| `POST /auth/login` / `POST /auth/register` | 20 req/min por IP | idem |
| `POST /api/panic-button` | 5 req/min por IP | `429 { "error": "TooManyRequests", "message": "..." }` |

### Pool de conexiones (`pg`)

`src/db/pool.js`: `max` = `DB_POOL_MAX` (default 10), `idleTimeoutMillis` 30000, `connectionTimeoutMillis` 5000. Sin límites explícitos el pool crece sin cota y agota las conexiones del Postgres compartido ante un pico de tráfico.

### Errores 5xx sanitizados

Un 4xx tipado (`ValidationError`, `NotFoundError`, etc.) sigue devolviendo su `message` tal cual. Un 5xx (error no controlado, típicamente de la base) **nunca** devuelve `err.message` crudo al cliente — responde `{ "error": "InternalServerError", "message": "Error interno" }` y el detalle real (stack, mensaje del driver) queda solo en el log (`secureLog`).

---

## API Endpoints

### GET `/api/user`

Perfil del usuario autenticado (groups del JWT). Requiere Bearer token.

**Response:**
```json
{
  "success": true,
  "data": {
    "sub": "U000042",
    "username": "jperez",
    "groups": ["citizen"],
    "module": "emergencias"
  }
}
```

### POST `/auth/dev/login` (solo `AUTH_MODE=local`)

Emite un access token de desarrollo. Ver ejemplo arriba.

### POST `/api/panic-button`

Activa el botón de pánico. Requiere JWT. El `userId` se toma de `sub`. Rate limit: **5 req/min por IP** (ver más abajo).

`latitude`/`longitude` se validan contra rango geográfico (`-90..90` / `-180..180`); fuera de rango → 400.

**`severity` ya no es un input:** el backend la deriva de `emergencyType` (ver tabla abajo). Si el body manda `severity`, se **ignora** (se loguea a nivel debug, no rompe con 400, para no romper clientes viejos hasta que se actualicen).

**Request:**
```json
{
  "location": {
    "latitude": -34.6037,
    "longitude": -58.3816
  },
  "description": "Necesito ayuda inmediata",
  "emergencyType": "INCENDIO"
}
```

**Response:**
```json
{
  "success": true,
  "emergencyId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Botón de pánico activado",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "U000042",
    "latitude": -34.6037,
    "longitude": -58.3816,
    "description": "Necesito ayuda inmediata",
    "emergencyType": "INCENDIO",
    "severity": "high",
    "status": "PENDING",
    "createdAt": "2026-08-25T10:00:00.000Z",
    "updatedAt": "2026-08-25T10:00:00.000Z"
  }
}
```

#### Severidad derivada por `emergencyType`

Decisión de producto: "la severidad no la elige quien reporta". Tabla en `src/domain/severity.js` (`severityForType`):

| `emergencyType` | `severity` |
|------------------|------------|
| `PANICO` | `critical` |
| `MEDICA` | `high` |
| `INCENDIO` | `high` |
| `DISTURBIO_EVENTO_MASIVO` | `medium` |
| `INFRAESTRUCTURA` | `medium` |
| `OTRO` | `low` |

Es la base sobre la que el Risk Engine en `main` (`src/domain/risk-engine.js`, job
`incident-detection-job`, merge #36) solo puede **subir** la prioridad, nunca bajarla
(`effectivePriority` / invariante en `severity.js`).

### GET `/api/panic-button/:id`

Obtiene detalles de un evento de pánico. Requiere JWT. Delega en el mismo método que `GET /api/emergencies/:id`: una emergencia ajena responde **404** (no 403), para no revelar que el id existe.

### GET `/api/emergencies`

Lista paginada de emergencias, con filtros por status, severity, rango de fechas, oficial asignado y tipo. Requiere `citizen` o `dispatcher` (citizen solo ve las propias).

### GET `/api/emergencies/:id`

Detalle con `statusHistory`. Mismas reglas de acceso que el listado.

### PATCH `/api/emergencies/:id/validate`

Dispatcher: `PENDING` → `VALIDATED`.

### PATCH `/api/emergencies/:id/discard`

Dispatcher: `PENDING` → `DISCARDED`. Body: `{ "reason": "..." }` (obligatorio).

### PATCH `/api/emergencies/:id/assign`

Dispatcher: `VALIDATED` → `DISPATCHED`. Body: `{ "officerId": "of-001" }`. El oficial debe existir y estar `disponible`; pasa a `ocupado`.

### GET `/api/officers`

Catálogo de oficiales para el dispatcher (`?status=disponible` opcional). Los oficiales **no** se autentican en este módulo.

### PATCH `/api/emergencies/:id/cancel`

Cancela una emergencia propia en estado `PENDING` o `VALIDATED`. Requiere JWT y grupo `citizen`. El `actor` se toma de `sub`.

**Request:**
```json
{
  "reason": "Falsa alarma"
}
```

### Auth en deploy (demo)

Con `AUTH_MODE=local` + `ALLOW_LOCAL_AUTH=true` cualquiera puede pedir un token dispatcher en `POST /auth/dev/login`. Para demo pública o con evaluadores externos: **sacar `ALLOW_LOCAL_AUTH`** o pasar a `AUTH_MODE=idp`. Demo de clase cerrada: se puede dejar.

### Ops: Postgres huérfano en Render

Si quedó un PostgreSQL de Render sin uso (tras migrar a Neon), borrarlo desde el dashboard de Render para no seguir pagando. No es un cambio de código.
### GET `/health`

Estado del servicio y conectividad Kafka (público).

---

## Máquina de estados

El ciclo de vida de una emergencia está centralizado en [`src/domain/emergency-status.js`](src/domain/emergency-status.js) (única fuente de verdad: la usan los controllers, el repository y el enum de Swagger).

```
              ┌────────────────┐
              ▼                │   (DISPATCHED → VALIDATED: devolución para reasignar)
PENDING ──► VALIDATED ──► DISPATCHED ──► EN_ROUTE ──► ON_SCENE ──► RESOLVED ──► CLOSED
   │                │
   ├──► CANCELLED ◄─┘   (desde PENDING o VALIDATED)
   └──► DISCARDED       (solo desde PENDING)
```

| Desde | Hacia |
|-------|-------|
| `PENDING` | `VALIDATED`, `CANCELLED`, `DISCARDED` |
| `VALIDATED` | `DISPATCHED`, `CANCELLED` |
| `DISPATCHED` | `EN_ROUTE`, `VALIDATED` |
| `EN_ROUTE` | `ON_SCENE` |
| `ON_SCENE` | `RESOLVED` |
| `RESOLVED` | `CLOSED` |
| `CANCELLED`, `DISCARDED`, `CLOSED` | — (terminales) |

Una transición no listada devuelve **409 Conflict** (`ConflictError`, p. ej. `Invalid transition PENDING → RESOLVED`). La validación corre en el controller y, como defensa en profundidad, en `EmergencyRepository.updateStatus` con la fila bloqueada (`FOR UPDATE`), así ningún endpoint puede saltarse el flujo.

---

## Arquitectura

```
src/
├── index.js                      # Composition root (Kafka + pool + app)
├── app.js                        # Express factory (inyectable en tests)
├── swagger.js                    # OpenAPI 3 + Swagger UI (/api-docs)
├── auth/
│   ├── authenticate.js           # Middleware Bearer JWT → req.user
│   ├── jwt-verifier.js           # verify() RS256 + claims CityPass+
│   ├── groups.js                 # citizen / dispatcher + permisos
│   ├── authorize.js              # requireGroups + reglas de ownership
│   ├── config.js                 # AUTH_MODE + IDP_* desde env
│   ├── setup.js                  # local vs idp (factory)
│   ├── local-keys.js             # RSA dev (AUTH_MODE=local)
│   └── local-token-issuer.js     # POST /auth/dev/login
├── security/
│   ├── location-crypto.js        # AES-256-GCM ubicación
│   ├── location-retention.js     # Job de anonimización
│   ├── secure-log.js             # Redacción de logs
│   ├── security-headers.js       # HTTPS/HSTS + headers
│   ├── cors.js                   # CORS_ALLOWED_ORIGINS + defaults dev/prod
│   └── rate-limit.js             # express-rate-limit (login, panic-button)
├── domain/
│   ├── emergency-status.js       # Máquina de estados (transiciones válidas)
│   ├── emergency-type.js         # Catálogo cerrado de emergencyType
│   └── severity.js               # severityForType: severidad derivada del tipo
├── controllers/
│   ├── panic-button.controller.js
│   ├── emergency.controller.js   # list/detail/validate/discard/assign/cancel
│   ├── officer.controller.js
│   └── user.controller.js
├── routes/
│   ├── panic-button.routes.js
│   ├── emergencies.routes.js
│   ├── officer.routes.js
│   ├── user.routes.js
│   └── dev-auth.routes.js        # Solo AUTH_MODE=local
├── repositories/
│   ├── emergency.repository.js   # SQL + mapper + transacciones
│   └── officer.repository.js
├── services/
│   └── kafka.service.js
├── errors/
│   └── app-errors.js
├── utils/
│   └── uuid.js                   # assertUuid: 400 antes de tocar Postgres
├── db/
│   └── pool.js                   # max/idleTimeout/connectionTimeout configurables
└── tests/
    ├── panic-button.test.js
    ├── officer.test.js
    ├── emergency-status.test.js
    ├── auth.test.js
    └── emergency.repository.integration.test.js

db/migrations/                    # Fuente de verdad del schema (Flyway)
```

---

## Persistencia (PostgreSQL / Neon)

Docker **no se va**: Kafka (y opcionalmente Postgres) siguen en `docker-compose`.

- **Neon:** DB remota compartida → `DATABASE_URL` + `DATABASE_SSL=true`. Ideal para el equipo y el secret del CD.
- **Postgres del compose:** DB local → URL `localhost:5434` + `DATABASE_SSL=false` (puerto 5434 para no chocar con un Postgres de Windows en 5432).

Detalle del schema y migrations: [db/README.md](db/README.md). Plantilla de env: [`.env.example`](.env.example).

---

## Kafka Topics

- `emergencias.boton-panico`: Eventos de botón de pánico
- `emergencias.estado-actualizado`: Cambios de estado (incluye cancelación y cierre; el cierre dejó de publicar un evento aparte)

Si Kafka no está conectado, `publishEvent` responde **503** (no se pierde el evento en silencio).

---

## Contrato de eventos (bus EDA)

> **Spec AsyncAPI:** [`asyncapi.yaml`](asyncapi.yaml) (AsyncAPI 3.1) describe los eventos que
> publicamos (`EmergenciaCreada`, `EmergenciaActualizada`, y el interno `EmergenciaPriorizada`)
> y los que consumimos de Espacios (`EventoComunitarioPublicado`, `EventoCancelado`).
> `src/tests/asyncapi.test.js` corre en `npm test` y falla si los builders de
> `src/services/emergency-events.js` dejan de cumplir el spec: **si cambiás el contrato,
> cambiá el YAML en el mismo PR.**
>
> - `npm run asyncapi:validate` — valida el spec con el parser oficial.
> - `npm run asyncapi:docs` — genera la documentación HTML en `docs/asyncapi/` (no se versiona).
> - También se puede pegar el YAML en [AsyncAPI Studio](https://studio.asyncapi.com).

Contrato cerrado por Juani el 2026-11-02 en el [comentario del issue #48](https://github.com/G6D2/demo-repository/issues/48#issuecomment-6589800911). Reemplaza los criterios originales de ese issue y las convenciones viejas (`emergencyType`, `severity` en inglés, `userId`, etc.). **La base de datos no cambia**: los renombres se hacen al armar el evento, en `src/services/emergency-events.js`.

### `com.citypass.emergencias.EmergenciaCreada`

| Campo | Tipo | Fuente / Default |
|---|---|---|
| `emergenciaId` | string | `emergencies.id` |
| `categoria` | string | `emergency_type` (catálogo: `MEDICA`, `INCENDIO`, `INFRAESTRUCTURA`, `DISTURBIO_EVENTO_MASIVO`, `OTRO`, `PANICO`; pendiente sumar `TRANSITO` y `PREVENTIVA`) |
| `prioridad` | `BAJA` \| `MEDIA` \| `ALTA` \| `CRITICA` | map desde `severity` (`low → BAJA`, `medium → MEDIA`, `high → ALTA`, `critical → CRITICA`) |
| `estado` | string | map desde `status` (ver tabla de estados) |
| `barrio` | string \| null | null hasta #76. Lo leen Reclamos y Analítica |
| `ubicacion.barrio` | string \| null | el mismo valor, anidado para Espacios |
| `afectaCirculacion` | boolean \| null | null hasta #76/#85 (con `false`, Reclamos descarta el evento) |
| `latitud`, `longitud` | double \| null | null hasta que cierre la regla "mandar sólo con `afectaCirculacion = true`" (Juani con Valentina) |
| `causaId`, `causaTipo` | string \| null / enum \| null | null hasta #77/#79/#80 (consumo de eventos externos) |
| `prioridadOriginal` | enum \| null | null hasta #79/#85 |
| `ciudadanoId` | string \| null | `user_id` |
| `correlationId` | string | `correlation_id` (fallback: `id`) |
| `createdAt` | ISO-8601 UTC | `created_at` |

**No viajan al bus:** `descripcion`, `titulo`, `direccion` (texto libre; analítica tiene columnas pero su código los deja null).

### `com.citypass.emergencias.EmergenciaActualizada`

Antes era `EmergenciaEstadoActualizado`. Reemplaza también a `EmergenciaCerrada` (eliminado del contrato): el cierre viaja como esta misma `EmergenciaActualizada` con `estadoNuevo = CERRADA`.

| Campo | Tipo | Fuente / Default |
|---|---|---|
| `emergenciaId` | string | `emergencies.id` |
| `estadoAnterior`, `estadoNuevo` | string español | map desde `previousStatus`/`newStatus` del history |
| `updatedAt` | ISO-8601 UTC | `emergencies.updated_at` |
| `resueltoAt` | ISO-8601 UTC \| null | sólo en transición a `RESUELTA` |
| `usuarioId` | string \| null | actor del request |
| `asignadoA` | string \| null | `assigned_officer_id` sólo en `DESPACHADA` (#85 pide un evento por recurso) |
| `areaResponsable` | string \| null | null hasta #85 |
| `resolucion` | string \| null | `reason` del request |
| `prioridad` | enum \| null | map desde `severity` |
| `correlationId` | string | `correlation_id` (fallback: `id`) |

### Tabla de traducción de estados

| DB (`emergencies.status`) | Bus EDA (`estado*`) |
|---|---|
| `PENDING` | `PENDIENTE` |
| `VALIDATED` | `VALIDADA` |
| `DISPATCHED` | `DESPACHADA` |
| `EN_ROUTE` | `EN_CAMINO` |
| `ON_SCENE` | `EN_LUGAR` |
| `RESOLVED` | `RESUELTA` |
| `CLOSED` | `CERRADA` |
| `DISCARDED` | `DESCARTADA` |
| `CANCELLED` | `CANCELADA` |

### Reglas duras

- Timestamps en **ISO-8601 UTC** (no milisegundos).
- `descripcion`, `titulo`, `direccion` **nunca** van al bus (texto libre).
- `EmergenciaCerrada` y `EmergenciaReportada.v2` quedaron descartados.
- Los renombres se hacen al armar el evento. La base de datos sigue en inglés; el issue #63 no es bloqueante para este contrato.

---

## Publisher al gateway EDA (issue #74)

Hay dos modos de publicación controlados por `EDA_PUBLISHER_MODE`:

| Modo | Qué hace |
|---|---|
| `kafka` (default) | `KafkaService` publica directo al broker configurado por `KAFKA_BROKER` |
| `gateway` | `GatewayPublisher` POSTea cada evento como JSON al gateway EDA (`EDA_API_URL`) con `Authorization: Bearer <token-de-servicio>` |

### Autenticación en modo `gateway` (OAuth2 client-credentials grupo5)

Confirmado con Delfina (G2) el 2026-11-02 — hay **dos flujos de auth** que
coexisten:

- **Empleado → Backend:** el frontend loguea al empleado contra el
  login-federado y manda el `access_token` como `Bearer` al backend. El
  backend valida ese token para autorizar la acción. El `sub` del empleado
  se persiste en el payload del evento (`data.userId` para el ciudadano
  denunciante, `data.actor` para dispatcher).
- **Backend → Gateway:** el `GatewayPublisher` usa un cliente OAuth2
  **de servicio** del backend (`grupo5` + secret, otorgado por Delfina)
  para obtener un token con `claim.namespace = "com.citypass.emergencias"`.
  El bus autoriza por ese namespace. **La identidad del empleado NO viaja
  en este token** (es `token_use: service`) — por eso se persiste en el
  payload al momento del request.

### Caching del token de servicio

`EdaAuthClient` cachea en memoria y renueva:
- **Proactivamente** `RENEW_BUFFER_MS` (default 120s) antes del expiry.
- **Reactivamente** cuando el gateway responde 401 — invalida el token y
  reintenta el POST UNA vez con un token fresco.

Request concurrente del outbox: `pendingRefresh` dedupe para que solo un
request renueve el token aunque haya N llamadas en vuelo.

### Clasificación de errores del gateway

| Status | Qué hace el outbox |
|---|---|
| `2xx` | `markPublished` con `payload_hash` y `gateway_event_id` del response |
| `401` | reintento interno con token fresco; si vuelve a 401 → `PermanentError` → `FAILED` |
| `400` / `403` / `404` / `413` | `PermanentError` → `FAILED` directo sin reintentar |
| `429` | respeta `Retry-After` si viene; outbox usa ese `retryAfterMs` como backoff |
| `5xx` y otros | transient — backoff exponencial del outbox |

### Env vars

```env
EDA_PUBLISHER_MODE=gateway                          # kafka (default) | gateway
EDA_API_URL=https://test.citypass.mrfranco.net.ar
EDA_OAUTH_TOKEN_URL=https://api.citypass-login.pp.ua/oauth/token
EDA_OAUTH_CLIENT_ID=grupo5
EDA_OAUTH_CLIENT_SECRET=<Delfina lo pasa por privado — NUNCA en el repo>
```

**Default:** si `EDA_PUBLISHER_MODE` no está seteado o vale `kafka`, el
`GatewayPublisher` ni se instancia — comportamiento idéntico al previo.

---

## ⚠️ Kafka: `kafka:29092` vs `localhost:9092`

El broker del `docker-compose.yml` expone **dos listeners**, y hay que usar el correcto según desde dónde corre el cliente:

| Cliente | Listener | Broker a usar |
|---|---|---|
| Proceso dentro de la red de Docker (ej. el backend de compose) | `PLAINTEXT` | `kafka:29092` |
| Proceso en el host (ej. `npm run dev`) | `PLAINTEXT_HOST` | `localhost:9092` |

**Trampa conocida:** si desde el host usás `localhost:29092`, la conexión inicial puede funcionar pero al publicar un evento el request queda colgado, con `getaddrinfo ENOTFOUND kafka` repetido en el log. Pasa porque ese puerto corresponde al listener `PLAINTEXT`, que en el handshake anuncia `kafka:29092` — un hostname que solo resuelve dentro de la red de Docker. El listener `PLAINTEXT_HOST`, publicado en el puerto `9092`, anuncia `localhost:9092` y es el que deben usar los clientes del host.

---

## 🧪 Testing

```bash
# Unitarios / API con mocks
npm test

# Integración del repository (Postgres efímero + Flyway; requiere Docker)
npm run test:integration
```

### Estrategia por capa

La prioridad de diseño está en la lógica de dominio (transiciones de estado, severidad, priorización, detección de incidentes), pero **también hay cobertura HTTP/API**: cada controller tiene su suite y las middlewares críticos (auth, authorize, cors, rate-limit, error handler) están testeados en aislamiento. Desglose:

| Capa | Archivos en `src/tests/` | Qué prueban |
|---|---|---|
| **Controllers / API** | `auth.test.js`, `auth-local.test.js`, `user.test.js`, `panic-button.test.js`, `emergency.test.js`, `officer.test.js`, `assign.test.js`, `incident.controller.test.js`, `incident.test.js` | Endpoints HTTP: statuses, payloads, autorización, validación de input, errores 4xx/5xx. Se monta la app con `createApp(...)` y se ejercitan con supertest. |
| **Middlewares** | `authorize.test.js`, `cors.test.js`, `rate-limit.test.js`, `app-error-handler.test.js` | Comportamiento de cada middleware en isolation (roles, orígenes permitidos, throttling por IP, sanitización de errores). |
| **Dominio** | `emergency-status.test.js`, `emergency-type.test.js`, `emergency-events.test.js`, `severity.test.js`, `incident-detector.test.js`, `risk-engine.test.js`, `rule-based-grouper.test.js`, `map-emergency.test.js` | Reglas puras: transiciones de estado, severidad derivada, priorización, agrupación por Union-Find. |
| **Servicios** | `kafka.service.test.js`, `outbox-publisher.test.js`, `keep-warm.test.js`, `location-retention.test.js`, `incident-detection-job.test.js` | Publicación al bus (con `kafkajs` mockeado), poll del outbox, job de retención, detección con lock cross-instance. |
| **Seguridad** | `security.test.js`, `secure-log.test.js`, `local-keys.test.js` | Headers, sanitización de logs (sin JWT ni lat/lng), rotación de keys. |
| **Repositories (unit)** | `emergency.repository.test.js`, `incident.repository.test.js`, `officer.repository.test.js` | Queries con `pg` mockeado. |
| **Repositories (integración)** | `emergency.repository.integration.test.js`, `incident.repository.integration.test.js`, `incident-detection-job.integration.test.js` | Postgres real (contenedor efímero + Flyway); en CI corren con el service `postgres:15-alpine`. |
| **Infra** | `flyway.test.js`, `pool.test.js` | Aplicación de migraciones, configuración del pool. |

Cobertura del último CI: ver `docs/diagramas/07-ci-cd.md` (statements ~97%, branches ~87%, functions ~96%, lines ~97%).

### Respuesta para la presentación

Si preguntan "¿por qué no testean controllers?": **sí los testean**. La respuesta correcta es que la **prioridad de diseño** es el dominio (transiciones, severidad, priorización), y ahí es donde hay más profundidad de casos; pero cada controller/endpoint tiene su suite HTTP con `createApp(...)` que valida statuses, autorización, y payloads. También hay cobertura de middlewares (auth, authorize, cors, rate-limit, error handler).

---

## Diagramas

Casos de uso, modelo entidad-relación, arquitectura (C4), máquina de estados, secuencias,
eventos de dominio, CI/CD y despliegue — generados desde el código real, en Mermaid:
[`docs/diagramas/`](docs/diagramas/README.md).

---

## ADRs Relacionados

- [ADR-001: Event-Driven Architecture](../ADRs/)
- [ADR-002: Kafka vs RabbitMQ](../ADRs/)

---

## Equipo

- **Backend:** Matías, Lucca
- **Security:** Valentina
- **DevOps:** Kevin
- **PM:** Juani
- **Frontend:** Santino
- **Scrum Master:** Sebastián

---

## Próximos Pasos

- [x] Persistencia de emergencias (PostgreSQL)
- [x] Cancelación de emergencias
- [x] Integración con Login Federado (auth JWT CityPass+)
- [x] Autorización por `groups` (citizen / dispatcher)
- [x] Validar / descartar / asignar oficial + catálogo `/api/officers`
- [x] Cifrado de ubicación + retención + logs seguros + auditoría de lecturas
- [ ] Alinear contrato HTTP de location (`lat`/`lng` vs `latitude`/`longitude`)
- [ ] Visualización en tiempo real (WebSockets/SSE) — hoy polling en front
- [ ] Ops: borrar Postgres huérfano de Render si aún existe (dashboard)