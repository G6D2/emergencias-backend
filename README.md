# Emergencias Backend

**CityPass+ - Módulo de Emergencias y Seguridad**

## Descripción

Backend para el módulo de Emergencias y Seguridad de CityPass+. Gestiona el botón de pánico, el ciclo de vida de cada emergencia (validar, despachar, seguimiento del oficial, cierre), la detección de incidentes y la cobertura preventiva que disparan los eventos de otros módulos.

## Caso de Uso 2: Botón de Pánico

**Objetivo:** Permitir que ciudadanos activen un botón de pánico que genere una emergencia crítica.

### Flujo
1. El ciudadano activa el botón de pánico en la app web (`POST /api/panic-button`).
2. El backend guarda la emergencia en PostgreSQL (`PENDING`) y, en la misma transacción, deja el evento `EmergenciaCreada` en `outbox_events`.
3. El outbox publisher lo manda al bus. En producción publica por el gateway del Grupo 1 desde el 05/11 (`EDA_PUBLISHER_MODE=gateway`, `OUTBOX_PUBLISHER_ENABLED=true`) al FQN `com.citypass.emergencias.EmergenciaCreada` (ver [Eventos](#eventos-bus-eda)).
4. El dispatcher la ve en su listado (`GET /api/emergencies`; el front hace polling, no hay push) y sigue el flujo de la [máquina de estados](#máquina-de-estados).

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
# Pegá la URL de Neon en .env (DATABASE_SSL=true). Para publicar en el Kafka
# local: KAFKA_ENABLED=true y OUTBOX_PUBLISHER_ENABLED=true (en .env.example
# vienen apagados)
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

# En .env: prender Kafka y el outbox (en .env.example vienen apagados) y apuntar
# al listener del host (NO al de Docker, ver sección Kafka más abajo)
#   KAFKA_ENABLED=true
#   OUTBOX_PUBLISHER_ENABLED=true
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

Pegá el `access_token` en `accessToken`. Para obtenerlo sin IdP usá **POST /auth/dev/login** o **POST /auth/login** (colección incluida).

---

## Autenticación (JWT CityPass+)

Los endpoints bajo `/api/*` exigen `Authorization: Bearer <access_token>`.

### Sin IdP (`AUTH_MODE=local`, default; así corre producción)

El backend emite sus propios JWT, que **respetan el mismo contrato** que CityPass+ (claims, RS256, `verify()`).

1. `POST /auth/register` — alta email+password (tabla `auth_users`, bcrypt)
2. `POST /auth/login` — login email+password → `access_token`
3. `POST /auth/dev/login` — token para un `sub` sin password. Con `DEV_LOGIN_STRICT=true` (producción) solo acepta los `sub` demo de la allowlist; sin modo estricto, cualquier `sub` y `groups`
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
| `AUTH_MODE` | `local` (default), `idp` o `hybrid` (Login Federado + cuentas locales, ver abajo) |
| `IDP_ISSUER` / `IDP_AUDIENCE` | Claims del token (defaults alineados al contrato) |
| `LOCAL_TOKEN_TTL_SECONDS` | Vida del token local (default 900) |
| `LOCAL_JWT_PRIVATE_KEY_PEM` | Opcional: misma clave entre reinicios |

`AUTH_MODE=local` **no arranca con `NODE_ENV=production`** salvo que esté `ALLOW_LOCAL_AUTH=true` (ver abajo). `AUTH_MODE=hybrid` no tiene esa traba.

### Producción (Render) sin Grupo 2

Producción corre con `AUTH_MODE=local` y `DEV_LOGIN_STRICT=true`. **No** corre con `NODE_ENV=production`: las respuestas no traen `Strict-Transport-Security` (verificado el 05/11/2026), así que tampoco necesita `ALLOW_LOCAL_AUTH`. La configuración está en [`render.yaml`](render.yaml).

Con `DEV_LOGIN_STRICT=true`, `POST /auth/dev/login` solo emite tokens para estos `sub` (`src/auth/dev-login-policy.js`), con groups fijos que el cliente no puede elegir:

| `sub` | Grupo |
|---|---|
| `U000042`, `CIT-JuanPanico`, `CIT-LuciaTranquila` | `citizen` (solo `CIT-JuanPanico` tiene botón antipánico) |
| `DISP-Demo001` | `dispatcher` |
| `of-001`, `of-002` | `officer` (el `sub` es el id del catálogo de oficiales) |

Cualquiera que conozca esos `sub` puede pedir un token, incluido el de dispatcher: sirve para una demo de clase, no para un entorno abierto.

Qué cambia con `NODE_ENV=production`: con `AUTH_MODE=local` el server no arranca sin `ALLOW_LOCAL_AUTH=true` (con `hybrid` no hace falta), se prenden HSTS + redirect a HTTPS, `DEV_LOGIN_STRICT` pasa a ser `true` por default y, si falta `CORS_ALLOWED_ORIGINS`, CORS cae al frontend de Render con un `warn`. Fuera de `production`, sin `CORS_ALLOWED_ORIGINS` el default es `http://localhost:3001`; por eso producción la tiene seteada.

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

Producción (en `render.yaml`; el servicio no usa Blueprint, así que se setea en el dashboard de Render):

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

`idp` sigue tal cual: contrato estricto y sin login local, así que deja afuera a los ciudadanos. Para tener el Login Federado del personal y las cuentas locales de los ciudadanos a la vez está `hybrid`.

La identidad queda en `req.user` (`sub`, `groups`, `username`, `jti`, …).  
**No se confía en `userId` ni `actor` del body** — salen del claim `sub`.

Token ausente o inválido → **401**. Sin grupo o sin permiso → **403**.

### Login Federado + cuentas locales (`AUTH_MODE=hybrid`)

Desde G6D2/Frontend#56 el front loguea al personal (dispatchers, oficiales, delegados) contra el Login Federado del Grupo 2 (`POST https://api.citypass-login.pp.ua/auth/login` con `clientId: citypass-emergencias-web`) y manda ese token al backend. Los ciudadanos siguen con cuenta local. `idp` deja afuera a los ciudadanos y `local` rechaza el token federado; `hybrid` acepta los dos:

- El `iss` del token decide cómo se valida: si es `IDP_ISSUER`, contra el JWKS del Login Federado (`IDP_JWKS_URI`) con `IDP_AUDIENCE`; si es `LOCAL_JWT_ISSUER`, contra la clave local con las mismas reglas que en `local`. Cualquier otro `iss` da **401**.
- `/auth/login`, `/auth/register` y `/auth/dev/login` siguen disponibles, con la misma política (`DEV_LOGIN_STRICT`).
- **No depende de `NODE_ENV`**: arranca igual con `production` y no pide `ALLOW_LOCAL_AUTH`, porque elegir `hybrid` ya es declarar que se aceptan tokens locales (`ALLOW_LOCAL_AUTH` se ignora). Lo que sí cambia con `production` es lo de siempre: HSTS, CORS estricto y `DEV_LOGIN_STRICT=true` por default.
- Los tokens locales salen con `iss=urn:citypass:emergencias:local` (o `LOCAL_JWT_ISSUER`): el Login Federado emite `iss=https://idp.citypass.local`, el mismo texto que usan los tokens locales en `local`. Al pasar de `local` a `hybrid`, los tokens locales vigentes (15 min) dan 401 y hay que volver a loguearse.

| | Token local | Token del Login Federado |
|---|---|---|
| Firma | RS256, clave local | RS256, JWKS de `IDP_JWKS_URI` |
| `iss` | `LOCAL_JWT_ISSUER` | `IDP_ISSUER` |
| `aud` | lista que incluye `LOCAL_JWT_AUDIENCE` | string o lista que incluye `IDP_AUDIENCE` |
| `exp` | obligatorio | obligatorio |
| `token_use` | obligatorio, `human` | si viene, `human` (un token de servicio da 401); obligatorio con `IDP_REQUIRE_TOKEN_USE=true` |
| `ver` | obligatorio, `1` | si viene, `1`; obligatorio con `IDP_REQUIRE_TOKEN_VER=true` |
| Usuario | `sub` | claim `IDP_SUBJECT_CLAIM` (default `sub`), traducido por `IDP_SUB_ALIASES` |
| Grupos | `groups` | claim `IDP_GROUPS_CLAIM` (default `groups`), traducido por `IDP_GROUP_MAP` |

**Grupos (`IDP_GROUP_MAP`).** JSON `{"grupo-federado": "interno"}` o `{"grupo-federado": ["interno", ...]}`; las claves no distinguen mayúsculas. Si se define, **reemplaza** al default. El default usa los mismos nombres que reconoce el front (`app/lib/auth-roles.js`):

| Grupo federado | Grupo interno |
|---|---|
| `dispatcher`, `dispatchers`, `operador` | `dispatcher` |
| `officer` | `officer` |
| `delegado`, `delegados` | `delegado` (no habilita ninguna ruta) |

Un grupo que no está en el mapa no otorga nada. `citizen` no está en el default a propósito: en `hybrid` los ciudadanos entran con cuenta local, y los tokens locales y federados comparten el espacio de `sub` (el contrato del Grupo 2 usa subs como `U000042`, que también es un sub demo local). Un federado con `citizen` podría ver las emergencias de un ciudadano local con el mismo `sub`. Si hace falta, se agrega con `IDP_GROUP_MAP`.

**Delegado.** Administra usuarios y grupos en el panel del Login Federado, pero no opera emergencias. Queda como grupo interno `delegado` sin permisos: `GET /api/user` lo devuelve (el front lo usa para mandarlo al panel) y cualquier otra ruta da 403.

**Oficiales (`IDP_SUB_ALIASES`).** Las rutas del oficial comparan `req.user.sub` con `assigned_officer_id` (`of-001`, `of-002`...). Con `{"sub-federado": "of-001"}`, `authenticate` le reemplaza el `sub` a ese token federado por el id del catálogo antes de autorizar. A partir de ahí todo ve el id interno: el chequeo de oficial asignado, el `actor` del historial y de los eventos y el rate limit. El sub federado queda en `req.user.idpSub`. No se aplica a tokens locales. Usar solo ids del catálogo de oficiales: un alias al `sub` de un ciudadano local lo dejaría operar como ese ciudadano.

**`GET /api/user`** devuelve además `authSource` (`local` o `federated`) y, en tokens federados, `idpSub` e `idpGroups` (los grupos tal como vinieron). Con eso se ve qué trae el token real y se arman `IDP_GROUP_MAP` e `IDP_SUB_ALIASES`.

| Variable (hybrid) | Default | Rol |
|---|---|---|
| `IDP_ISSUER` | obligatoria | `iss` del Login Federado. El contrato del Grupo 2 dice `https://idp.citypass.local` |
| `IDP_AUDIENCE` | obligatoria | Audience que tiene que estar en `aud`. Por el contrato, `citypass-emergencias-api` (a confirmar con un token real) |
| `IDP_JWKS_URI` | obligatoria | `https://api.citypass-login.pp.ua/.well-known/jwks.json`. Solo `https` (`http` únicamente contra localhost) |
| `IDP_CLOCK_TOLERANCE_SECONDS` | `60` | Tolerancia de reloj para `exp`, en los dos tipos de token |
| `IDP_REQUIRE_TOKEN_USE` | `false` | `true`: `token_use` obligatorio en tokens federados |
| `IDP_REQUIRE_TOKEN_VER` | `false` | `true`: `ver` obligatorio en tokens federados |
| `IDP_SUBJECT_CLAIM` | `sub` | Claim con el id del usuario. El contrato dice `sub` y pide no usar nunca `preferred_username` como clave |
| `IDP_GROUPS_CLAIM` | `groups` | Claim con los grupos (lista de strings o un string) |
| `IDP_GROUP_MAP` | el de la tabla | JSON grupo federado → grupo interno |
| `IDP_SUB_ALIASES` | vacío | JSON sub federado → id interno |
| `LOCAL_JWT_ISSUER` | `urn:citypass:emergencias:local` | `iss` de los tokens locales; tiene que ser distinto de `IDP_ISSUER` |
| `LOCAL_JWT_AUDIENCE` | `citypass-emergencias-api` | `aud` de los tokens locales |

`LOCAL_TOKEN_TTL_SECONDS` y `LOCAL_JWT_PRIVATE_KEY_PEM` funcionan igual que en `local`. Una variable mal formada (JSON roto, grupo interno que no existe, `IDP_JWKS_URI` sin https, booleano que no es `true`/`false`, issuers iguales) frena el arranque con el error.

**Para prenderlo en Render:**

```env
AUTH_MODE=hybrid
IDP_ISSUER=https://idp.citypass.local
IDP_AUDIENCE=citypass-emergencias-api
IDP_JWKS_URI=https://api.citypass-login.pp.ua/.well-known/jwks.json
```

`IDP_ISSUER` e `IDP_AUDIENCE` ya existen en Render: hay que revisar que tengan esos valores (o los que muestre un token real). `IDP_JWKS_URI` falta cargarla. `IDP_SUB_ALIASES` se carga cuando se sepa el `sub` de cada oficial. Para volver atrás alcanza con `AUTH_MODE=local`.

**A confirmar con un token real** (decodificar solo el payload, sin pegar el token entero en ningún lado): que `iss` sea `https://idp.citypass.local`; qué trae `aud` y si es lista o string; si vienen `token_use: "human"` y `ver: 1` (si vienen, prender `IDP_REQUIRE_TOKEN_USE` e `IDP_REQUIRE_TOKEN_VER`); que el usuario esté en `sub`; y cómo se llaman los grupos de dispatchers, oficiales y delegados en el panel. El contrato de referencia es la guía de integración del Grupo 2 (`docs/externo/GRUPO-2-AUTENTICACION.md` del repo `carlos-illobre/citypass-event-gateway`).

### Autorización por `groups`

Grupo desconocido no otorga nada. La comparación ignora mayúsculas y espacios de los costados (`Dispatcher` = `dispatcher`). Mapa actual del módulo:

| Grupo | Permisos |
|-------|----------|
| `citizen` | Activar pánico; ver y cancelar **solo sus** emergencias; perfil y ubicaciones frecuentes propias |
| `dispatcher` | Ver cualquier emergencia; validar, descartar, asignar, devolver y cerrar; ver oficiales, incidentes y el outbox |
| `officer` | Avanzar el estado operativo (en camino, en el lugar, resuelta) **solo** de la emergencia que tiene asignada: el `sub` del token tiene que ser `assigned_officer_id` |
| `delegado` | Nada: solo lo informa `GET /api/user` (llega del Login Federado en `hybrid`) |

### Endpoints

Lista completa, sacada de `src/routes/` y `src/app.js`. El detalle de cada uno (parámetros, respuestas, schemas) está en Swagger (`/api-docs`).

| Endpoint | Acceso | Regla extra |
|----------|--------|-------------|
| `GET /health` | público | estado en memoria de Kafka (`connected`, `disconnected` o `disabled`), del outbox y de cada listener |
| `GET /api-docs`, `GET /api-docs.json` | público | Swagger UI y spec OpenAPI |
| `POST /auth/register` | público, `AUTH_MODE=local` o `hybrid` | 20 req/min por IP |
| `POST /auth/login` | público, `AUTH_MODE=local` o `hybrid` | 20 req/min por IP |
| `POST /auth/dev/login` | público, `AUTH_MODE=local` o `hybrid` | 10 req/min por IP; allowlist con `DEV_LOGIN_STRICT` |
| `GET /api/user` | autenticado | devuelve `sub`, `groups`, `username` del JWT; en `hybrid`, además `authSource` y, si el token es federado, `idpSub` e `idpGroups` |
| `POST /api/panic-button` | `citizen` | 5 req/min por IP; `emergencyType=PREVENTIVA` → 400 |
| `GET /api/panic-button/:id` | `citizen` o `dispatcher` | citizen: solo propias (404 si ajena); deja registro de auditoría |
| `GET /api/emergencies` | `citizen` o `dispatcher` | citizen: solo propias y sin `incident`/`effectivePriority` |
| `GET /api/emergencies/:id` | `citizen` o `dispatcher` | citizen: solo propias (404 si ajena) |
| `PATCH /api/emergencies/:id/validate` | `dispatcher` | `PENDING` → `VALIDATED` |
| `PATCH /api/emergencies/:id/discard` | `dispatcher` | `PENDING` → `DISCARDED`; `reason` obligatorio |
| `PATCH /api/emergencies/:id/assign` | `dispatcher` | `VALIDATED` → `DISPATCHED`; el oficial tiene que estar `disponible` y pasa a `ocupado` |
| `PATCH /api/emergencies/:id/return` | `dispatcher` | `DISPATCHED` → `VALIDATED`; libera al oficial; `reason` opcional |
| `PATCH /api/emergencies/:id/en-route` | `officer` | `DISPATCHED` → `EN_ROUTE`; solo el oficial asignado (404 si no) |
| `PATCH /api/emergencies/:id/on-scene` | `officer` | `EN_ROUTE` → `ON_SCENE`; solo el oficial asignado |
| `PATCH /api/emergencies/:id/resolve` | `officer` | `ON_SCENE` → `RESOLVED`; solo el oficial asignado |
| `PATCH /api/emergencies/:id/close` | `dispatcher` | `RESOLVED` → `CLOSED`; setea `closedAt` y libera al oficial |
| `PATCH /api/emergencies/:id/cancel` | `citizen` | solo dueño (404 si ajena); desde `PENDING` o `VALIDATED` |
| `GET /api/officers` | `dispatcher` | catálogo local; `?status=disponible\|ocupado` opcional |
| `GET /api/incidents` | `dispatcher` | incidentes activos (con alguna emergencia no terminal), paginado |
| `GET /api/incidents/:id` | `dispatcher` | incidente con sus emergencias miembro, sin coordenadas |
| `GET /api/citizen/profile` | `citizen` | perfil propio (vacío si no se guardó) |
| `PUT /api/citizen/profile` | `citizen` | crea o actualiza; 30 cambios/min por IP en `/api/citizen/*` |
| `GET /api/citizen/saved-locations` | `citizen` | ubicaciones frecuentes propias |
| `POST /api/citizen/saved-locations` | `citizen` | agrega una |
| `PATCH /api/citizen/saved-locations/:id` | `citizen` | modifica una propia |
| `DELETE /api/citizen/saved-locations/:id` | `citizen` | borra una propia |
| `GET /api/outbox-events` | `dispatcher` | estado de los eventos sin payload; filtros `status`, `topic`, `page`, `limit` (máx. 100) |

Una ruta o método que no existe responde **404** en JSON (`{ "error": "NotFoundError", "message": "Cannot GET /..." }`).

En dev login sin modo estricto podés probar groups distintos:
```json
{ "sub": "U000042", "groups": ["citizen"] }
{ "sub": "U000999", "groups": ["dispatcher"] }
{ "sub": "of-001", "groups": ["officer"] }
```

Token ausente o inválido → **401 Unauthorized**. `/health`, `/api-docs*` y `/auth/*` (`AUTH_MODE=local` o `hybrid`) son públicos.

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

### Coords cifradas en el bus (`ubicacion.latitud` / `ubicacion.longitud`)
En `EmergenciaCreada`, las coordenadas exactas van **solo** en `data.ubicacion.*`, cifradas con **`BUS_LOCATION_ENCRYPTION_KEY`** (distinta a la de DB).

Guía **autocontenida** para mandar a otros equipos (sin depender del repo): **[docs/bus-ubicacion-para-consumidores.md](docs/bus-ubicacion-para-consumidores.md)**.

### Retención / minimización
Job en background (y `npm run security:anonymize-locations`) borra el ciphertext `LOCATION_RETENTION_HOURS` (default 72) **después de `closed_at`**. Emergencias abiertas (`closed_at` null) no se tocan. La fila sigue existiendo; `latitude`/`longitude` quedan `null` y `locationAnonymized: true`. El **barrio** se conserva (y se deriva antes de borrar si faltaba). Al anonimizar también se ponen en `null` `ubicacion.latitud`/`longitud` en los payloads del outbox de esas emergencias.

Si una fila fue cifrada con otra clave (por ejemplo, insertada desde un entorno local apuntando a la base compartida), el listado no falla: esa emergencia vuelve con `latitude`/`longitude` en `null` y `locationUnavailable: true`, y queda un `warn` en el log con su id. Para sanearlas: `npm run security:anonymize-undecryptable` (con `DATABASE_URL` y `LOCATION_ENCRYPTION_KEY` del entorno afectado).

### Logs seguros
No se loguean JWT ni coordenadas. Los eventos se loguean solo como resumen (`topic`, `type`, ids, `hasLocation`), nunca el payload.

### HTTPS / headers
Siempre: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, etc. Con `NODE_ENV=production` o `FORCE_HTTPS=true`, además HSTS + redirect a HTTPS (vía `X-Forwarded-Proto`, típico en Render). Producción hoy no tiene ninguna de las dos, así que no manda HSTS.

### Auditoría de lectura
Solo `GET /api/panic-button/:id` deja registro: después de autorizar la lectura, inserta una fila en `emergency_access_audit` (`emergency_id`, `actor_sub`, `action = 'emergency:read'`, `created_at`). Si ese insert falla, la lectura responde igual y el error queda en el log.

`GET /api/emergencies` y `GET /api/emergencies/:id` **no** dejan registro, y no hay endpoint para consultar la auditoría (se lee en la base). Los cambios de estado no van a esta tabla: quedan en `emergency_status_history`, con `actor` y `reason`.

| Variable | Rol |
|----------|-----|
| `LOCATION_ENCRYPTION_KEY` | AES-256 key (base64, 32 bytes) — **obligatoria** (salvo que se use `LOCATION_ENCRYPTION_KEYS`) |
| `LOCATION_ENCRYPTION_KEYS` | Keyring para rotar: `id:base64key,id2:base64key2` (opcional) |
| `LOCATION_ENCRYPTION_KEY_ID` | Id de la clave con la que se cifra (default: `1`, o la primera del keyring) |
| `BUS_LOCATION_ENCRYPTION_KEY` | AES-256 para `ubicacion.latitud/longitud` en el bus (base64, 32 bytes). **Distinta** a la de DB. Opcional: sin ella esas coords salen null. Compartirla con consumidores por canal seguro |
| `BUS_LOCATION_ENCRYPTION_KEYS` / `BUS_LOCATION_ENCRYPTION_KEY_ID` | Keyring de bus (mismo formato que at-rest) |
| `LOCATION_RETENTION_HOURS` | Horas tras el cierre (`closed_at`) antes de anonimizar (default 72) |
| `LOCATION_RETENTION_ENABLED` | `false` para desactivar el job |
| `FORCE_HTTPS` | Forzar HTTPS aunque no sea production |
| `CORS_ALLOWED_ORIGINS` | Origins permitidos (coma-separados). Sin ella: `http://localhost:3001` fuera de producción; en producción exige la variable y si falta cae a `https://frontend-krds.onrender.com` con un warn en el log (nunca refleja el origin del request) |
| `DB_POOL_MAX` | Máximo de conexiones del pool de `pg` (default 10) |
| `RATE_LIMIT_ENABLED` | `false` apaga el rate limiting (default: activo) |

El health check reporta el estado de Kafka (`connected`, `disconnected` o `disabled` con `KAFKA_ENABLED=false`) con lo que el proceso ya sabe, sin conectarse al broker: `connected` si el producer (cuando el outbox publica) y cada listener con topic están arriba. En producción el outbox no publica. Ojo: que el producer esté conectado no garantiza que publicar ande — ver la sección de Kafka para una trampa conocida al publicar desde el host.

### Rate limiting

`express-rate-limit`, activo por default (`RATE_LIMIT_ENABLED=false` lo apaga; útil en tests, que reusan la misma app/IP para muchos requests seguidos):

| Endpoint | Límite | Respuesta al exceder |
|----------|--------|-----------------------|
| `POST /auth/dev/login` | 10 req/min por IP | `429 { "error": "TooManyRequests", "message": "..." }` |
| `POST /auth/login` | 20 intentos fallidos/min por IP (los logins exitosos no cuentan) | idem |
| `POST /auth/register` | 20 req/min por IP, contador propio | idem |
| `POST /api/panic-button` | 5 activaciones/min por ciudadano (`sub` del token; las que fallan no cuentan), más un tope de 300 req/min por IP antes de autenticar | `429 { "error": "TooManyRequests", "message": "..." }` |
| `PUT`/`POST`/`PATCH`/`DELETE` en `/api/citizen/*` | 30 req/min por IP | idem |

### Pool de conexiones (`pg`)

`src/db/pool.js`: `max` = `DB_POOL_MAX` (default 10), `idleTimeoutMillis` 30000, `connectionTimeoutMillis` 5000, `keepAlive`. Sin límites explícitos el pool crece sin cota y agota las conexiones del Postgres compartido ante un pico de tráfico.

Contra un Postgres directo también manda `statement_timeout` (10 s) e `idle_in_transaction_session_timeout` (15 s). Contra el pooler de Neon (host `-pooler`) no: PgBouncer rechaza esos startup parameters y cortaría todas las conexiones. Ahí se configuran por rol, una vez, desde la consola de Neon:

```sql
ALTER ROLE <rol> SET statement_timeout = '10s';
ALTER ROLE <rol> SET idle_in_transaction_session_timeout = '15s';
```

Un client ocioso que se corta (Neon suspende el compute) se loguea con `pool.on('error')` en vez de tirar el proceso.

### Errores 5xx sanitizados

Un 4xx tipado (`ValidationError`, `NotFoundError`, etc.) sigue devolviendo su `message` tal cual. Un 5xx (error no controlado, típicamente de la base) **nunca** devuelve `err.message` crudo al cliente — responde `{ "error": "InternalServerError", "message": "Error interno" }` y el detalle real (stack, mensaje del driver) queda solo en el log (`secureLog`).

---

## API Endpoints

La tabla completa está en [Endpoints](#endpoints). Acá, los que necesitan más detalle.

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

### POST `/auth/dev/login` (`AUTH_MODE=local` o `hybrid`)

Emite un access token de desarrollo. Ver ejemplo y allowlist arriba.

### POST `/api/panic-button`

Activa el botón de pánico. Requiere grupo `citizen`. El `userId` se toma de `sub`. Rate limit: **5 req/min por IP**. Responde **201**.

`latitude`/`longitude` se validan contra rango geográfico (`-90..90` / `-180..180`); fuera de rango → 400. `address` es opcional (≤200 caracteres, se guarda cifrada junto con la ubicación). `emergencyType` acepta el catálogo menos `PREVENTIVA` (400), que la crea solo el sistema; sin tipo es `PANICO`.

**`severity` ya no es un input:** el backend la deriva de `emergencyType` (ver tabla abajo). Si el body manda `severity`, se **ignora** (se loguea a nivel debug, no rompe con 400, para no romper clientes viejos hasta que se actualicen).

**Request:**
```json
{
  "location": {
    "latitude": -34.6037,
    "longitude": -58.3816
  },
  "address": "Av. Corrientes 1234, CABA",
  "description": "Necesito ayuda inmediata",
  "emergencyType": "INCENDIO"
}
```

**Response (201):**
```json
{
  "success": true,
  "emergencyId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Botón de pánico activado",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "correlationId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "U000042",
    "latitude": -34.6037,
    "longitude": -58.3816,
    "address": "Av. Corrientes 1234, CABA",
    "locationAnonymized": false,
    "locationUnavailable": false,
    "description": "Necesito ayuda inmediata",
    "severity": "high",
    "status": "PENDING",
    "assignedOfficerId": null,
    "assignedOfficer": null,
    "incidentId": null,
    "emergencyType": "INCENDIO",
    "source": "INTERNAL",
    "requiresManualValidation": false,
    "causaTipo": null,
    "causaId": null,
    "createdAt": "2026-08-25T10:00:00.000Z",
    "updatedAt": "2026-08-25T10:00:00.000Z",
    "closedAt": null
  }
}
```

`source`, `requiresManualValidation`, `causaTipo` y `causaId` distinguen las emergencias que crea el sistema a partir de eventos de otros módulos (ver [Consumo de eventos externos](#consumo-de-eventos-externos)). En un alta ciudadana siempre valen `INTERNAL`, `false`, `null` y `null`.

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
| `PREVENTIVA` | `low` (solo la crea la cobertura preventiva) |

Es la base sobre la que el Risk Engine (`src/domain/risk-engine.js`, job
`incident-detection-job`) solo puede **subir** la prioridad, nunca bajarla
(`effectivePriority` / invariante en `severity.js`).

### GET `/api/panic-button/:id`

Detalle de una emergencia. Delega en el mismo método que `GET /api/emergencies/:id` (una emergencia ajena responde **404**, no 403, para no revelar que el id existe) y además deja el registro de [auditoría de lectura](#auditoría-de-lectura).

### GET `/api/emergencies`

Lista paginada (`page`, `limit` hasta 100) con filtros por `status` (lista separada por coma), `severity`, `from`/`to`, `assignedOfficerId` y `emergencyType` (o `type`). `sortBy=priority` ordena por prioridad de despacho (`dispatchPriority`: la efectiva más un nivel si hay un [contexto de zona](#prioridad-elevada-durante-un-evento) vigente en el barrio). Citizen solo ve las propias y sin `incident`/`effectivePriority`/`dispatchPriority`/`priorityContext`.

### GET `/api/emergencies/:id`

Detalle con `statusHistory` (transiciones con `actor` y `reason`), `incident` y `effectivePriority`. A diferencia del listado, el detalle no le recorta `incident`/`effectivePriority` al citizen dueño. `observations` y `reinforcementRequests` vuelven siempre vacíos (no hay registro de esas cosas).

### Cambios de estado (dispatcher)

- `PATCH /api/emergencies/:id/validate`: `PENDING` → `VALIDATED`.
- `PATCH /api/emergencies/:id/discard`: `PENDING` → `DISCARDED`. Body: `{ "reason": "..." }` (obligatorio).
- `PATCH /api/emergencies/:id/assign`: `VALIDATED` → `DISPATCHED`. Body: `{ "officerId": "of-001" }`. El oficial tiene que existir y estar `disponible`; pasa a `ocupado`.
- `PATCH /api/emergencies/:id/return`: `DISPATCHED` → `VALIDATED` (devolución para reasignar). Body opcional: `{ "reason": "..." }`. El oficial vuelve a `disponible`.
- `PATCH /api/emergencies/:id/close`: `RESOLVED` → `CLOSED`. Setea `closedAt` y el oficial vuelve a `disponible`.

Al devolver, cancelar o cerrar, el oficial vuelve a `disponible`, pero `assignedOfficerId` queda con su id en la emergencia.

### Estado operativo (oficial asignado)

`PATCH /api/emergencies/:id/en-route` (`DISPATCHED` → `EN_ROUTE`), `.../on-scene` (`EN_ROUTE` → `ON_SCENE`) y `.../resolve` (`ON_SCENE` → `RESOLVED`). Requieren grupo `officer` y que el `sub` del token sea el `assigned_officer_id` de la emergencia; si no, **404**. No se puede saltear un estado (409). Resolver no libera al oficial: eso pasa al cerrar.

### PATCH `/api/emergencies/:id/cancel`

Cancela una emergencia propia en estado `PENDING` o `VALIDATED`. Requiere grupo `citizen`; una ajena responde 404. El `actor` se toma de `sub`.

**Request:**
```json
{
  "reason": "Falsa alarma"
}
```

### GET `/api/officers`

Catálogo de oficiales para el dispatcher (`?status=disponible` opcional). El catálogo vive en la tabla `officers` (V11); los oficiales se loguean con su id como `sub` (`of-001`, `of-002` en el dev login).

### GET `/api/incidents` y `/api/incidents/:id`

Resultado del motor de detección (dispatcher). El listado trae los incidentes con al menos una emergencia no terminal; el detalle suma las emergencias miembro sin coordenadas.

### `/api/citizen/*`

Perfil personal (`GET`/`PUT /api/citizen/profile`) y ubicaciones frecuentes (`GET`/`POST /api/citizen/saved-locations`, `PATCH`/`DELETE /api/citizen/saved-locations/:id`). Solo grupo `citizen`, siempre sobre el `sub` del token. Teléfono, contacto, condición médica y las coordenadas se guardan cifrados.

### GET `/api/outbox-events`

Estado de los eventos del outbox para el dispatcher: `id`, `topic`, `status`, `attempts`, fechas y `lastError`, sin el payload. Filtros `status` (`PENDING`, `PROCESSING`, `PUBLISHED`, `FAILED`, `SKIPPED`) y `topic`.

### GET `/health`

Estado del servicio (público). Responde con lo que el proceso tiene en memoria, sin conectarse al broker ni a la base:

```json
{
  "status": "ok",
  "timestamp": "2026-11-05T15:00:00.000Z",
  "kafka": "connected",
  "outbox": { "enabled": false, "lastPollAt": null, "producerConnected": false },
  "listeners": [
    { "name": "EventoCanceladoListener", "running": true, "status": "running", "lastPollAt": "2026-11-05T14:59:58.000Z", "nextRetryAt": null }
  ]
}
```

`status` de un listener: `starting` (primer intento), `running`, `retrying` (falló y todavía no volvió a arrancar: se reintenta a los 5 s, 30 s, 2 min y después cada 2 min; `nextRetryAt` dice cuándo es el próximo intento), `disabled` (sin topic) o `stopped`. `lastPollAt` es el último fetch al broker (kafkajs hace long polling, así que se actualiza cada pocos segundos aunque no haya mensajes).

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

Todas las transiciones tienen endpoint:

| Desde | Hacia | Endpoint | Quién |
|-------|-------|----------|-------|
| `PENDING` | `VALIDATED` | `PATCH /api/emergencies/:id/validate` | `dispatcher` |
| `PENDING` | `DISCARDED` | `PATCH /api/emergencies/:id/discard` | `dispatcher` |
| `PENDING`, `VALIDATED` | `CANCELLED` | `PATCH /api/emergencies/:id/cancel` | `citizen` dueño (o el listener, si Espacios cancela el evento de una cobertura preventiva) |
| `VALIDATED` | `DISPATCHED` | `PATCH /api/emergencies/:id/assign` | `dispatcher` |
| `DISPATCHED` | `VALIDATED` | `PATCH /api/emergencies/:id/return` | `dispatcher` |
| `DISPATCHED` | `EN_ROUTE` | `PATCH /api/emergencies/:id/en-route` | `officer` asignado |
| `EN_ROUTE` | `ON_SCENE` | `PATCH /api/emergencies/:id/on-scene` | `officer` asignado |
| `ON_SCENE` | `RESOLVED` | `PATCH /api/emergencies/:id/resolve` | `officer` asignado |
| `RESOLVED` | `CLOSED` | `PATCH /api/emergencies/:id/close` | `dispatcher` |

`CANCELLED`, `DISCARDED` y `CLOSED` son terminales. Cada transición deja una fila en `emergency_status_history` (con `actor` y `reason`) y un `EmergenciaActualizada` en el outbox, en la misma transacción.

Una transición no listada devuelve **409 Conflict** (`ConflictError`, p. ej. `Invalid transition PENDING → RESOLVED`). La validación corre en el controller y, como defensa en profundidad, en `EmergencyRepository.updateStatus` con la fila bloqueada (`FOR UPDATE`), así ningún endpoint puede saltarse el flujo.

---

## Arquitectura

```
src/
├── index.js                      # Composition root: pool, Kafka, outbox publisher, listeners, jobs y app
├── app.js                        # Express factory (inyectable en tests), /health y Swagger
├── swagger.js                    # OpenAPI 3 base (schemas); los paths salen del JSDoc de app.js y routes/
├── auth/
│   ├── authenticate.js           # Middleware Bearer JWT → req.user (+ IDP_SUB_ALIASES)
│   ├── authorize.js              # requireGroups + reglas de dueño y de oficial asignado
│   ├── config.js                 # AUTH_MODE + IDP_* / LOCAL_JWT_* desde env
│   ├── dev-login-policy.js       # Allowlist de /auth/dev/login (DEV_LOGIN_STRICT)
│   ├── federated-claims.js       # IDP_GROUP_MAP e IDP_SUB_ALIASES (hybrid)
│   ├── federated-verifier.js     # verify() RS256 de tokens del Login Federado (hybrid)
│   ├── groups.js                 # citizen / dispatcher / officer / delegado + permisos
│   ├── hybrid-verifier.js        # Elige verifier local o federado según el iss
│   ├── jwt-verifier.js           # verify() RS256 + claims CityPass+ (tokens locales e idp)
│   ├── local-keys.js             # RSA local (AUTH_MODE=local y hybrid)
│   ├── local-token-issuer.js     # Emite los JWT locales
│   └── setup.js                  # local, idp o hybrid (factory)
├── controllers/
│   ├── auth.controller.js        # /auth/register y /auth/login
│   ├── citizen-profile.controller.js
│   ├── emergency.controller.js   # Listado, detalle y todos los cambios de estado
│   ├── incident.controller.js
│   ├── officer.controller.js
│   ├── panic-button.controller.js
│   └── user.controller.js
├── db/
│   ├── connection.js             # Reexporta pool.js (compat)
│   └── pool.js                   # Pool de pg: max, timeouts y SSL configurables
├── domain/
│   ├── emergency-status.js       # Máquina de estados (transiciones válidas)
│   ├── emergency-type.js         # Catálogo cerrado de emergencyType (incluye PREVENTIVA)
│   ├── severity.js               # severityForType + effectivePriority + dispatchPriority
│   ├── contexto-zona.js          # tipos y ventana de vigencia de los contextos de zona
│   ├── incident-detector.js      # Arma incidentes a partir de los grupos
│   ├── incident-detection-strategy.js  # DBSCAN primaria, reglas como fallback
│   ├── dbscan-grouper.js
│   ├── rule-based-grouper.js
│   └── risk-engine.js            # Score y prioridad del incidente
├── errors/
│   └── app-errors.js
├── jobs/
│   └── keep-warm.js              # Pings en horario de clase (Render free)
├── listeners/                    # Consumo de eventos externos (ver src/listeners/README.md)
│   ├── event-listener.js         # Listener abstracto: consumer, decode, reglas
│   ├── event-decoder.js          # Avro (schema registry) o JSON
│   ├── error-classifier.js       # Transitorio (reentrega) vs permanente (descarta)
│   ├── outcome-factory.js        # Ejecuta los resultados en una transacción con dedup
│   ├── business-rule.js
│   ├── load-rules.js
│   └── cobertura-preventiva/     # EventoComunitarioPublicado y EventoCancelado de Espacios
├── repositories/
│   ├── auth-user.repository.js
│   ├── citizen-profile.repository.js
│   ├── emergency.repository.js   # SQL + mapper + transacciones + outbox
│   ├── eventos-procesados.repository.js  # Dedup de eventos consumidos
│   ├── incident.repository.js
│   └── officer.repository.js
├── routes/
│   ├── citizen-profile.routes.js
│   ├── dev-auth.routes.js        # Solo AUTH_MODE=local
│   ├── emergencies.routes.js
│   ├── incidents.routes.js
│   ├── officer.routes.js
│   ├── outbox.routes.js
│   ├── panic-button.routes.js
│   └── user.routes.js
├── security/
│   ├── citizen-profile-retention.js  # Job de minimización del perfil
│   ├── cors.js                   # CORS_ALLOWED_ORIGINS + defaults dev/prod
│   ├── location-crypto.js        # AES-256-GCM de ubicaciones
│   ├── location-retention.js     # Job de anonimización
│   ├── pii-scrub.js              # Limpia PII de la descripción libre
│   ├── rate-limit.js             # express-rate-limit
│   ├── secure-log.js             # Redacción de logs
│   └── security-headers.js       # Headers + HTTPS/HSTS
├── services/
│   ├── eda-auth-client.js        # Token client-credentials del Login Federado
│   ├── emergency-events.js       # Builders de los eventos
│   ├── incident-detection-job.js # Cada 60 s, con advisory lock
│   ├── kafka.service.js          # Cliente Kafka (SASL/SSL), producer y health
│   └── outbox-publisher.js
├── utils/
│   ├── async-handler.js
│   └── uuid.js                   # assertUuid: 400 antes de tocar Postgres
└── tests/                        # Jest: unit (*.test.js) e integración (*.integration.test.js)

db/migrations/                    # Fuente de verdad del schema (Flyway: V1…V16, V21…V24 y V26; la V25 queda para el barrio, #82)
scripts/                          # migrate (Flyway), seed, anonimización, demo de DBSCAN
docs/                             # Diagramas y documentos técnicos
postman/                          # Colección y environment
```

---

## Persistencia (PostgreSQL / Neon)

Docker **no se va**: Kafka (y opcionalmente Postgres) siguen en `docker-compose`.

- **Neon:** DB remota compartida → `DATABASE_URL` + `DATABASE_SSL=true`. Ideal para el equipo y el secret del CD.
- **Postgres del compose:** DB local → URL `localhost:5434` + `DATABASE_SSL=false` (puerto 5434 para no chocar con un Postgres de Windows en 5432).

Detalle del schema y migrations: [db/README.md](db/README.md). Plantilla de env: [`.env.example`](.env.example).

---

## Eventos (bus EDA)

### Cómo salen

Cada operación que crea una emergencia o le cambia el estado deja su evento en `outbox_events` en la **misma transacción** (outbox transaccional). El `OutboxPublisher` reclama los pendientes cada 5 s y los manda a Kafka; si un envío falla, reintenta con backoff exponencial y, después de `OUTBOX_MAX_ATTEMPTS`, lo marca `FAILED`. Los `PUBLISHED` se purgan a las `OUTBOX_PUBLISHED_RETENTION_HOURS`. Al arrancar, el publisher pasa a `SKIPPED` los `PENDING` anteriores a `OUTBOX_PUBLISH_SINCE`.

**En producción el publisher está prendido desde el 05/11** con `EDA_PUBLISHER_MODE=gateway` y `OUTBOX_PUBLISHER_ENABLED=true`: `EmergenciaCreada` y `EmergenciaActualizada` salen por HTTP al gateway, a los FQN `com.citypass.emergencias.*`, y `EmergenciaPriorizada` queda `SKIPPED`. Sin `OUTBOX_PUBLISHER_ENABLED=true` no se publica nada, pero tampoco se pierde: los eventos quedan `PENDING` en `outbox_events` (`GET /api/outbox-events`).

Tópicos actuales (los propios del módulo, no los FQN del gateway):

| Evento (`type`) | Tópico (env → default) | Cuándo |
|---|---|---|
| `EmergenciaCreada` | `TOPIC_PANIC_BUTTON` → `emergencias.boton-panico` | Alta por `POST /api/panic-button`, y alta de una cobertura preventiva por el listener |
| `EmergenciaActualizada` | `TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO` → `emergencias.estado-actualizado` | Cada cambio de estado (`validate`, `discard`, `assign`, `return`, `en-route`, `on-scene`, `resolve`, `close`, `cancel`) y la cancelación de una cobertura preventiva. El cierre viaja acá con `estadoNuevo = CERRADA`: no hay `EmergenciaCerrada` |
| `EmergenciaPriorizada` | `TOPIC_EMERGENCIA_PRIORIZADA` → `emergencias.priorizada` | Job de detección de incidentes (cada 60 s), solo si cambió la prioridad del incidente; uno por emergencia miembro |

Sobre de todos los eventos: `{ type, eventId, correlationId, data }`. `eventId` lo genera `insertOutboxEvent`; `correlationId` va en la raíz y también dentro de `data`. Se publica con `key: null`, así que no hay orden garantizado entre eventos de una misma emergencia (ver [`docs/diagramas/06-eventos.md`](docs/diagramas/06-eventos.md)).

### Contrato de `EmergenciaCreada` y `EmergenciaActualizada`

> **Spec AsyncAPI:** [`asyncapi.yaml`](asyncapi.yaml) (AsyncAPI 3.1) describe los eventos que
> publicamos (`EmergenciaCreada`, `EmergenciaActualizada`, y el interno `EmergenciaPriorizada`)
> y los que consumimos de Espacios (`EventoComunitarioPublicado`, `EventoCancelado`).
> `src/tests/asyncapi.test.js` corre en `npm test` y falla si los builders de
> `src/services/emergency-events.js` dejan de cumplir el spec: **si cambiás el contrato,
> cambiá el YAML en el mismo PR.**
>
> - **Página web:** `GET /asyncapi` (al lado de Swagger en `/api-docs`), con el viewer oficial de AsyncAPI;
>   el YAML crudo está en `GET /asyncapi.yaml`. En Render: https://emergencias-backend-34go.onrender.com/asyncapi
> - `npm run asyncapi:validate` — valida el spec con el parser oficial.
> - `npm run asyncapi:docs` — genera la documentación HTML en `docs/asyncapi/` (no se versiona).
> - También se puede pegar el YAML en [AsyncAPI Studio](https://studio.asyncapi.com).

Contrato cerrado por Juani el 2026-11-02 en el [comentario del issue #48](https://github.com/G6D2/demo-repository/issues/48#issuecomment-6589800911). Reemplaza los criterios originales de ese issue y las convenciones viejas (`emergencyType`, `severity` en inglés, `userId`, etc.). **La base de datos no cambia**: los renombres se hacen al armar el evento, en `src/services/emergency-events.js`. En el contrato los nombres son FQN (`com.citypass.emergencias.EmergenciaCreada`); el `type` que sale hoy es el nombre corto.

#### `EmergenciaCreada`

| Campo | Tipo | Fuente / valor hoy |
|---|---|---|
| `emergenciaId` | string | `emergencies.id` |
| `categoria` | string | `emergency_type` (catálogo: `MEDICA`, `INCENDIO`, `INFRAESTRUCTURA`, `DISTURBIO_EVENTO_MASIVO`, `OTRO`, `PANICO`, `PREVENTIVA`; pendiente sumar `TRANSITO`) |
| `prioridad` | `BAJA` \| `MEDIA` \| `ALTA` \| `CRITICA` | map desde `severity` (`low → BAJA`, `medium → MEDIA`, `high → ALTA`, `critical → CRITICA`) |
| `estado` | string | map desde `status` (ver tabla de estados) |
| `barrio` | string \| null | catálogo oficial CABA (48 barrios), en claro; lo leen Reclamos/Analítica |
| `ubicacion.barrio` | string \| null | el mismo valor, anidado (Espacios) |
| `ubicacion.latitud`, `ubicacion.longitud` | string \| null | ciphertext AES-256-GCM (clave **de bus**). Plaintext `{"value": <number>}` + AAD `emergenciaId\|campo`. Sin clave de bus → null. **No** hay lat/lng en la raíz de `data` |
| `afectaCirculacion` | boolean \| null | derivado por `categoria`: `true` para `INCENDIO`, `INFRAESTRUCTURA`, `DISTURBIO_EVENTO_MASIVO`, `PREVENTIVA` (y `TRANSITO` cuando entre al catálogo); `false` para `MEDICA`, `PANICO`, `OTRO`; `null` si no hay tipo. Con `false`, Reclamos descarta el evento |
| `causaId`, `causaTipo` | string \| null | `causa_id` / `causa_tipo`. En un alta ciudadana, `null`; la cobertura preventiva manda el `eventoId` de Espacios y `EVENTO_PUBLICO` |
| `prioridadOriginal` | enum \| null | hoy siempre `null` |
| `ciudadanoId` | string \| null | `user_id`; `null` en las emergencias externas |
| `correlationId` | string | `correlation_id` (fallback: `id`) |
| `createdAt` | ISO-8601 UTC | `created_at` |

**No viajan al bus:** `descripcion`, `titulo`, `direccion` (texto libre; analítica tiene columnas pero su código los deja null).

#### `EmergenciaActualizada`

Antes era `EmergenciaEstadoActualizado`, y reemplaza también a `EmergenciaCerrada`.

| Campo | Tipo | Fuente / valor hoy |
|---|---|---|
| `emergenciaId` | string | `emergencies.id` |
| `estadoAnterior`, `estadoNuevo` | string español | map desde `previousStatus`/`newStatus` del history |
| `updatedAt` | ISO-8601 UTC | `emergencies.updated_at` |
| `resueltoAt` | ISO-8601 UTC \| null | solo cuando `estadoNuevo = RESUELTA`: el momento en que se arma el evento (no hay columna `resolved_at`) |
| `usuarioId` | string \| null | actor: `sub` de quien hizo el cambio; `eda:espacios` cuando cancela el listener |
| `asignadoA` | string \| null | `assigned_officer_id`, solo en `DESPACHADA` (un evento por despacho) |
| `areaResponsable` | string \| null | hoy siempre `null` |
| `resolucion` | string \| null | `reason` del cambio: motivo de `discard`, `cancel` o `return`, `Assigned officer <id>` en `assign`; `null` en `validate`, `en-route`, `on-scene`, `resolve` y `close` |
| `prioridad` | enum \| null | map desde `severity` |
| `correlationId` | string | `correlation_id` (fallback: `id`) |

#### `EmergenciaPriorizada`

No forma parte del contrato del #48: conserva los nombres en inglés y la prioridad en minúscula.

| Campo | Fuente |
|---|---|
| `id`, `correlationId` | la emergencia miembro |
| `incidentId` | incidente al que pertenece |
| `priorityIndividual` | `severity` de la emergencia |
| `incidentPriority` | prioridad del incidente |
| `priority` | prioridad final del miembro: la mayor entre las dos |
| `score`, `reasonCodes`, `algorithmVersion` | resultado del Risk Engine (`dbscan-v1` o `rule-based-v1`) |

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

### JSON Schema

Los dos eventos están en [`docs/contratos/emergencia-creada.schema.json`](docs/contratos/emergencia-creada.schema.json) y [`docs/contratos/emergencia-actualizada.schema.json`](docs/contratos/emergencia-actualizada.schema.json) (draft-07, todos los campos `required`, `additionalProperties: false`). `src/tests/outbox-contract.integration.test.js` los valida con `ajv` contra las filas reales que deja en `outbox_events` el ciclo completo por HTTP: si cambia un campo en `emergency-events.js` sin tocar el schema, o al revés, el CI falla.

---

## Consumo de eventos externos

Con `KAFKA_CONSUMER_ENABLED=true` (así corre producción), el backend arranca los listeners de `src/listeners/` dentro del mismo proceso web. Los dos eventos de Espacios Públicos que escucha disparan dos cosas: la **cobertura preventiva** y el **contexto de zona** que eleva la prioridad en el barrio mientras dura el evento (ver [Prioridad elevada durante un evento](#prioridad-elevada-durante-un-evento)):

| Evento | Topic (env) | Qué hace |
|---|---|---|
| `EventoComunitarioPublicado` | `EDA_TOPIC_EVENTO_PUBLICADO` | Si `capacidad` (o `cupoMaximo`) llega a `UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA` (default 500) y el evento no está `CANCELLED`, crea **una** emergencia `PREVENTIVA` por `eventoId`: `source = EXTERNAL`, sin ciudadano, `causaTipo = EVENTO_PUBLICO`, `causaId = eventoId`, severidad `low`, estado `PENDING`. Sin coordenadas queda con `requiresManualValidation = true`. Publica `EmergenciaCreada` por el outbox. Aparte, sin importar la capacidad, registra el contexto de zona del evento |
| `EventoCancelado` | `EDA_TOPIC_EVENTO_CANCELADO` | Cancela la cobertura de ese `eventoId` si sigue en `PENDING` o `VALIDATED` (actor `eda:espacios`, con historial y `EmergenciaActualizada`). Si ya fue despachada, no la toca. Aparte, da de baja el contexto de zona del evento |

### Prioridad elevada durante un evento

Mientras dura un evento comunitario, las emergencias de su barrio suben **un nivel** de prioridad de despacho (tope `critical`). Es la decisión del ADR *Elevar temporalmente la prioridad con contextos de zona*.

- **Alta.** Cada `EventoComunitarioPublicado` deja (o actualiza) una fila en `contexto_zona` (V28), una por `eventoId`: el barrio se deriva de `latitud`/`longitud` (sin coordenadas, del texto `barrio` o `zona` si coincide con el catálogo de CABA) y la ventana es `inicio`–`fin` del evento (también `fechaInicio`–`fechaFin`). Sin inicio, arranca al recibir el evento; sin fin, dura `CONTEXTO_ZONA_DURACION_DEFAULT_HORAS` (default 6). Un evento sin barrio derivable no genera contexto.
- **Baja.** `EventoCancelado` (o un `EventoComunitarioPublicado` con `estado = CANCELLED`) marca `dado_de_baja_en`. Es definitiva: una republicación posterior no revive el contexto, y una cancelación que llega antes que la publicación deja la marca para que la publicación tardía se ignore.
- **Cálculo.** No se escribe nada en `emergencies`. `GET /api/emergencies` y el detalle devuelven al dispatcher `dispatchPriority` (= `effectivePriority` más un nivel si hay un contexto vigente en `emergencies.barrio` en el momento de la lectura) y `priorityContext` con el motivo (`tipo`, `barrio`, `referenciaExterna`, `descripcion`, `vigenteDesde`, `vigenteHasta`), o `null`. `sortBy=priority` ordena por `dispatchPriority` en SQL. Cuando el evento termina o se cancela, la siguiente lectura ya no trae el contexto y la prioridad vuelve sola, sin job.
- **Alcance.** Varios eventos en el mismo barrio suben un solo nivel. No sube en las `PREVENTIVA` (la cobertura del propio evento) ni en emergencias en estado terminal. El ciudadano no recibe estos campos.
- **Hacia afuera.** La suba es interna: `EmergenciaCreada` y `EmergenciaActualizada` siguen publicando la prioridad original y no hay un evento por cada cambio. Quien la necesite la recalcula con los eventos de Espacios y los nuestros: guía autocontenida para otros equipos en **[docs/prioridad-por-contexto-para-consumidores.md](docs/prioridad-por-contexto-para-consumidores.md)**.
- **Falta** (del ADR): alta y baja manual desde el tablero, alertas climáticas, el evento `EmergenciaPriorizada` y la prioridad manual por encima del cálculo.

Cómo lee el bus:

- Mensajes Avro en formato Confluent, con el schema del registry del gateway (`EDA_SCHEMA_REGISTRY_URL`). Un mensaje que no empieza con el byte mágico se lee como JSON (tests y Kafka local).
- SASL/OAUTHBEARER con el token client-credentials del Login Federado (`EDA_OAUTH_*`) y SSL (`KAFKA_SSL=true`). El registry usa el mismo token.
- `group.id` = `com.citypass.emergencias.<Listener>` (el broker solo acepta grupos con ese prefijo).
- Dedup por `metadata.eventId` en `eventos_procesados` (V22), en la misma transacción que los efectos: un duplicado o una republicación no crean nada nuevo. Espacios republica `EventoComunitarioPublicado` cada vez que cambian los inscriptos; además, un índice único de V23 garantiza una sola `PREVENTIVA` por evento.
- Un error transitorio (base o registry caídos) no confirma el offset y Kafka reentrega. Uno permanente (payload inválido, sin handler) queda como `DISCARDED` en `eventos_procesados` y el offset avanza. Un mensaje ilegible se loguea y se saltea.

El servicio corre en Render free, que duerme sin tráfico: mientras duerme no consume. Al despertar, el grupo sigue desde su último offset confirmado. Si todavía no confirmó ninguno (nunca procesó un mensaje), arranca desde el final del topic y lo publicado mientras dormía se pierde.

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

Solo salen al bus `EmergenciaCreada` y `EmergenciaActualizada`, los tipos del contrato. `EmergenciaPriorizada` es interna: el publisher la devuelve como salteada y el outbox la marca `SKIPPED` sin llamar al gateway.

### Env vars

```env
OUTBOX_PUBLISHER_ENABLED=true                       # sin esto el outbox no publica en ningún modo
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
| **Controllers / API** | `auth.test.js`, `auth-local.test.js`, `auth-register.test.js`, `user.test.js`, `panic-button.test.js`, `emergency.test.js`, `officer.test.js`, `assign.test.js`, `return-emergency.test.js`, `operational-status.test.js`, `citizen-profile.test.js`, `incident.controller.test.js`, `incident.test.js` | Endpoints HTTP: statuses, payloads, autorización, validación de input, errores 4xx/5xx. Se monta la app con `createApp(...)` y se ejercitan con supertest. |
| **Middlewares** | `authorize.test.js`, `cors.test.js`, `rate-limit.test.js`, `app-error-handler.test.js` | Comportamiento de cada middleware en isolation (roles, orígenes permitidos, throttling por IP, sanitización de errores). |
| **Dominio** | `emergency-status.test.js`, `emergency-type.test.js`, `emergency-events.test.js`, `severity.test.js`, `incident-detector.test.js`, `incident-detection-strategy.test.js`, `dbscan-grouper.test.js`, `risk-engine.test.js`, `rule-based-grouper.test.js`, `map-emergency.test.js` | Reglas puras: transiciones de estado, severidad derivada, contrato de eventos, priorización, agrupación (DBSCAN y Union-Find). |
| **Servicios** | `kafka.service.test.js`, `eda-auth-client.test.js`, `outbox-publisher.test.js`, `keep-warm.test.js`, `location-retention.test.js`, `incident-detection-job.test.js` | Cliente Kafka (con `kafkajs` mockeado), token del Login Federado, poll del outbox, job de retención, detección con lock cross-instance. |
| **Listeners** | `listeners/*.test.js`, `listeners/cobertura-preventiva/*.test.js` | Decoder Avro/JSON, clasificación de errores, carga de reglas, `OutcomeFactory` con dedup, reglas y handlers de la cobertura preventiva. |
| **Seguridad** | `security.test.js`, `security-hardening.test.js`, `secure-log.test.js`, `local-keys.test.js` | Headers, sanitización de logs (sin JWT ni lat/lng), rotación de keys. |
| **Repositories (unit)** | `emergency.repository.test.js`, `incident.repository.test.js`, `officer.repository.test.js` | Queries con `pg` mockeado. |
| **Autorización** | `authorization-matrix.test.js` | Cada endpoint protegido × {sin token, token sin grupo, citizen, dispatcher, officer} con JWT RS256 real: 401, 403 o pasa, según `src/auth/authorize.js`. Corre también con `AUTH_MODE=hybrid` (tokens locales y del Login Federado simulado: grupos en mayúsculas, alias de oficial, delegado, iss y audience ajenos, token de servicio). Falla si se agrega una ruta y no se suma a la matriz. |
| **Repositories e integración** | `emergency.repository.integration.test.js`, `incident.repository.integration.test.js`, `incident-detection-job.integration.test.js`, `eventos-procesados.repository.integration.test.js`, `operational-status.integration.test.js`, `listeners/consumer.integration.test.js` | Postgres real (contenedor efímero + Flyway); en CI corren con el service `postgres:15-alpine`. |
| **Flujos de punta a punta (integración)** | `emergency-lifecycle.integration.test.js`, `emergency-rules-v26.integration.test.js`, `outbox-contract.integration.test.js`, `listeners/consumer-avro.integration.test.js` | Ciclo completo por HTTP con JWT local real (estado, historial, oficial, `closed_at`, outbox) y ramas cancel/discard/return; validate/return con estado de origen, `closed_at` en terminales y V26; el outbox real contra el JSON Schema de `docs/contratos`; el consumer con Avro en formato Confluent y un registry HTTP local. |
| **Infra** | `flyway.test.js`, `pool.test.js` | Aplicación de migraciones, configuración del pool. |

Último CI de `main` (05/11/2026, [run 42050901474](https://github.com/G6D2/emergencias-backend/actions/runs/42050901474)): 739 tests unitarios y 75 de integración; cobertura statements 95,73 %, branches 84,78 %, functions 95,65 %, lines 96,54 %. El gate interno es 80 % (ver `docs/diagramas/07-ci-cd.md`).

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

## Estado

Implementado en `main`:

- Botón de pánico y reporte con tipo, dirección cifrada y severidad derivada del tipo.
- Ciclo de vida completo por API: validar, descartar, asignar, devolver, en camino, en el lugar, resolver, cerrar y cancelar.
- Grupos `citizen`, `dispatcher` y `officer` con JWT del contrato CityPass+ (emitido por el propio backend, `AUTH_MODE=local`).
- Detección de incidentes cada 60 s (DBSCAN con fallback a reglas) y prioridad efectiva.
- Cifrado de ubicación y perfil, retención, logs seguros, rate limiting y auditoría de lectura en `GET /api/panic-button/:id`.
- Outbox transaccional con los eventos del contrato del #48 y consumo de eventos de Espacios (cobertura preventiva).

Lo que hoy no está:

- Publicación al bus: en producción sale por el gateway (`EDA_PUBLISHER_MODE=gateway`) desde el 05/11. El modo `kafka` sigue publicando en los tópicos propios (`emergencias.*`), no en los FQN del gateway.
- Login federado: `AUTH_MODE=idp` está programado, pero producción usa `AUTH_MODE=local`.
- Tiempo real: el front hace polling, no hay WebSocket ni SSE.
- `barrio`, `afectaCirculacion`, `latitud`/`longitud` y `prioridadOriginal` salen siempre en `null` en `EmergenciaCreada`.
