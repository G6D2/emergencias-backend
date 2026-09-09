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
- Node.js 18+
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

1. `POST /auth/dev/login` → devuelve `access_token` (mismo shape que el IdP)
2. Mandá ese token en `Authorization: Bearer …` al resto de la API

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
```

El server arranca con `NODE_ENV=production` y expone `POST /auth/dev/login` para obtener tokens.  
**Sacá `ALLOW_LOCAL_AUTH` cuando pasen a IdP real** — es solo para la primera entrega.

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
| `dispatcher` | Ver **cualquier** emergencia (solo lectura por ahora) |

| Endpoint | Grupo requerido | Regla extra |
|----------|-----------------|-------------|
| `GET /api/user` | autenticado | devuelve `sub`, `groups`, `username` del JWT |
| `POST /api/panic-button` | `citizen` | — |
| `GET /api/panic-button/:id` | `citizen` o `dispatcher` | citizen: solo `userId === sub` |
| `GET /api/emergencies` | `dispatcher` | listado paginado, con filtros |
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
3. Cuando ya no queden filas con `v1` (con retención de 72h, después de 72h),
   sacar `v1` del keyring.

Las filas escritas antes de esta versión no tienen cabecera y se desencriptan
probando las claves del keyring, así que la migración no requiere backfill.

### Retención / minimización
Job en background (y `npm run security:anonymize-locations`) borra el ciphertext después de `LOCATION_RETENTION_HOURS` (default 72). La emergencia sigue existiendo; `latitude`/`longitude` quedan `null` y `locationAnonymized: true`.

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
| `LOCATION_RETENTION_HOURS` | Horas antes de anonimizar (default 72) |
| `LOCATION_RETENTION_ENABLED` | `false` para desactivar el job |
| `FORCE_HTTPS` | Forzar HTTPS aunque no sea production |
| `CORS_ORIGIN` | Origins permitidos (coma-separados) en prod |

El health check reporta el estado de Kafka (`connected`/`disconnected`). Ojo: `connected` solo indica que el producer se conectó — ver la sección de Kafka para una trampa conocida al publicar desde el host.

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

Activa el botón de pánico. Requiere JWT. El `userId` se toma de `sub`.

**Request:**
```json
{
  "location": {
    "latitude": -34.6037,
    "longitude": -58.3816
  },
  "description": "Necesito ayuda inmediata",
  "severity": "critical"
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
    "severity": "critical",
    "status": "PENDING",
    "createdAt": "2026-08-25T10:00:00.000Z",
    "updatedAt": "2026-08-25T10:00:00.000Z"
  }
}
```

### GET `/api/panic-button/:id`

Obtiene detalles de un evento de pánico. Requiere JWT.

### GET `/api/emergencies`

Lista paginada de emergencias, con filtros por status, severity, rango de fechas, oficial asignado y tipo. Requiere grupo `dispatcher`.

### PATCH `/api/emergencies/:id/cancel`

Cancela una emergencia propia en estado `PENDING` o `VALIDATED`. Requiere JWT y grupo `citizen`. El `actor` se toma de `sub`.

**Request:**
```json
{
  "reason": "Falsa alarma"
}
```

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
│   └── security-headers.js       # HTTPS/HSTS + headers
├── domain/
│   └── emergency-status.js       # Máquina de estados (transiciones válidas)
├── controllers/
│   ├── panic-button.controller.js
│   ├── emergency.controller.js
│   └── user.controller.js
├── routes/
│   ├── panic-button.routes.js
│   ├── emergencies.routes.js
│   ├── user.routes.js
│   └── dev-auth.routes.js        # Solo AUTH_MODE=local
├── repositories/
│   └── emergency.repository.js   # SQL + mapper + transacciones
├── services/
│   └── kafka.service.js
├── errors/
│   └── app-errors.js
├── db/
│   └── pool.js
└── tests/
    ├── panic-button.test.js
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
- `emergencias.estado-actualizado`: Cambios de estado (p. ej. cancelación)

Si Kafka no está conectado, `publishEvent` responde **503** (no se pierde el evento en silencio).

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
- [ ] Visualización en tiempo real (WebSockets)
- [x] Integración con Login Federado (auth JWT CityPass+)
- [x] Autorización por `groups` (citizen / dispatcher)
- [x] Cifrado de ubicación + retención + logs seguros + auditoría de lecturas
- [ ] Alinear contrato HTTP de location (`lat`/`lng` vs `latitude`/`longitude`)
