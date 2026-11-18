# Integraciones técnicas: Login Federado, bus EDA y eventos de otros equipos

Documento de síntesis (front + back) de lo que hubo que implementar para:

1. Conectarse al **Login Federado del Grupo 2** (otro repo/servicio) y usarlo también en el caso de mensajes/eventos de **Reclamos**.
2. Comunicarse con el **bus EDA del Grupo 1** por eventos, en lugar de un Kafka propio.
3. **Consumir eventos de otros equipos** (Reclamos, Movilidad, Espacios) y **publicar un contrato usable** para quienes nos consumen (Analítica, Reclamos, Movilidad, Residuos, Espacios).

Repos: `emergencias-backend` y `Frontend` (CityPass+ Emergencias, Grupo 6). Decisiones formales: repo [`G6D2/ADRs`](https://github.com/G6D2/ADRs) / [g6d2.github.io/ADRs](https://g6d2.github.io/ADRs/). Detalle operativo en el README de cada repo y en `docs/diagramas/`.

---

## 1. Login Federado (Grupo 2)

**ADR:** [Usar el Login Federado para el personal y cuentas locales para los ciudadanos](https://g6d2.github.io/ADRs/ver.html?adr=usar-el-login-federado-para-el-personal-y-cuentas-locales-para-los-ciudadanos) (aceptada 2026-11-17; reemplaza identidad 100 % local).

### Problema

Hacían falta dos cosas a la vez:

- Que el **personal municipal** (dispatcher, oficial, delegado) entre con el IdP LDAP del Grupo 2.
- Que los **ciudadanos** sigan con cuentas locales del módulo (registro/login propio), porque el IdP no cubre ese flujo de demo/ciudadano.

Un modo solo-IdP (`idp`) dejaba afuera a los ciudadanos. Un modo solo-local (`local`) rechazaba el JWT federado. La solución fue **`AUTH_MODE=hybrid`**.

### Qué se implementó en el backend

| Pieza | Dónde | Qué hace |
|-------|--------|----------|
| Modos `local` / `idp` / `hybrid` | `src/auth/config.js`, `setup.js` | Elige el verifier según configuración |
| Verifier híbrido | `src/auth/hybrid-verifier.js` | Mira el `iss` del JWT y valida con claves locales o con el JWKS del IdP |
| Verifier federado | `src/auth/federated-verifier.js` | RS256 vía JWKS remoto (`jose`), `iss`/`aud`/`exp` exactos |
| Emisión local | `src/auth/local-token-issuer.js`, `local-keys.js` | JWT propio con `iss` distinto del IdP |
| Mapa de grupos | `src/auth/federated-claims.js`, `groups.js` | LDAP → grupos internos (`dispatcher`, `officer`/`poli`, `delegado`) |
| Aliases de oficiales | `IDP_SUB_ALIASES` | `sub` federado → `of-001`… del catálogo |
| Authorize | `src/auth/authorize.js` | `requireCitizen` / `requireDispatcher` / `requireOfficer` |
| Rutas locales | `src/routes/dev-auth.routes.js` | `/auth/register`, `/auth/login`, `/auth/dev/login` (solo en `local`/`hybrid`) |

**Contrato de tokens (producción):**

| | Local | Login Federado |
|---|--------|----------------|
| `iss` | `urn:citypass:emergencias:local` (`LOCAL_JWT_ISSUER`) | `https://idp.citypass.local` (`IDP_ISSUER`) |
| `aud` | `LOCAL_JWT_AUDIENCE` | `citypass-emergencias-api` |
| Firma | RSA local (`LOCAL_JWT_PRIVATE_KEY_PEM`) | JWKS `IDP_JWKS_URI` |
| Quién | Ciudadanos + atajos demo | Personal municipal |

Variables clave: `AUTH_MODE`, `IDP_ISSUER`, `IDP_AUDIENCE`, `IDP_JWKS_URI`, `IDP_GROUP_MAP`, `IDP_SUB_ALIASES`, `LOCAL_JWT_*`.

### Qué se implementó en el frontend (BFF)

El navegador **no** habla con el IdP ni con el backend con el token en JS. Next.js actúa como BFF:

| Pieza | Dónde | Qué hace |
|-------|--------|----------|
| Login LDAP | `app/api/auth/login/route.js` | Si `loginType=ldap`, POST al IdP con `{ username, password, clientId }` |
| Cookies | `lib/session.js` | `citypass_session` (access JWT) + `citypass_refresh` (solo federado) |
| Refresh | `app/api/auth/refresh` + `SessionRefreshManager` | Renueva sesión federada (~13 min); local no se renueva |
| Logout | `app/api/auth/logout` | Revoca refresh en el IdP (best-effort) y limpia cookies |
| Roles | `app/lib/auth-roles.js` | `poli` → `/oficial`; `delegados` → panel LDAP externo |
| Proxy | `app/api/backend/[...path]` | Adjunta `Authorization: Bearer` desde la cookie |
| UI | `app/acceso/AccesoForm.js` | Pestaña “Personal municipal (LDAP)” |

Defaults IdP: `CITYPASS_IDP_AUTH_URL` → `https://api.citypass-login.pp.ua/auth/login`, `clientId: citypass-emergencias-web`.

No hay Keycloak/OIDC redirect: es login usuario/contraseña LDAP contra la API del Grupo 2, más JWT en cookie httpOnly.

### Para qué lo usamos en el caso de mensajes/eventos de Reclamos

Hay **dos usos distintos** del Login Federado; ambos hacen falta para el caso ciclovía/reclamos:

#### A) Token de servicio (máquina → bus EDA)

Independiente del login humano. El backend obtiene un token OAuth2 **client-credentials** (`EDA_OAUTH_*`, `src/services/eda-auth-client.js`) contra el mismo ecosistema del Grupo 2, para:

- autenticarse al broker Kafka del bus (SASL/OAUTHBEARER),
- publicar por el gateway HTTP,
- hablar con el schema registry (Avro).

Sin ese token de servicio **no se pueden consumir** los tópicos de Reclamos/Movilidad (`ReclamoCreado`, `ReclamoActualizado`, `EmergenciaSolicitada`, etc.). El “mensaje recibido desde Reclamos” viaja por el bus, no por HTTP con el JWT del dispatcher.

#### B) Token humano (operar la emergencia que nació del reclamo)

Cuando llega el evento, el listener crea una emergencia `TRANSITO` con `source=EXTERNAL`, `causaTipo=RECLAMO`. A partir de ahí el flujo es el de siempre: el **dispatcher** valida/asigna y el **oficial** avanza estados por HTTP.

Eso exige:

1. Front: login LDAP → cookie con JWT federado.
2. Back: `AUTH_MODE=hybrid` + verificación JWKS + mapa de grupos (+ aliases de oficiales).
3. UI: la emergencia aparece en el tablero con origen “reclamo” (`emergencyOrigin.js`, badge/notice); el historial puede mostrar actores tipo `eda:reclamos`.

Sin (A) no entra el mensaje. Sin (B) entra al sistema pero el personal no puede operarlo en producción.

**Flujo de negocio (resumen):** ciudadano reporta ciclovía bloqueada en Reclamos → (default) Movilidad evalúa y publica `EmergenciaSolicitada` → Emergencias crea una intervención por `reclamoId` → si Reclamos cierra el reclamo (`ReclamoActualizado` final) y la emergencia sigue `PENDING`/`VALIDATED`, se cancela. Plan B: crear directo desde `ReclamoCreado` con `RECLAMO_INTERVENCION_DISPARADOR=reclamo|ambos`. Ver `src/listeners/reclamo-intervencion/` y `docs/diagramas/05-secuencias.md`.

Además, Reclamos **consume** nuestros `EmergenciaCreada`/`EmergenciaActualizada` (escala por barrio, filtra con `afectaCirculacion`); ver §4 y `docs/bus-ubicacion-para-consumidores.md`.

---

## 2. Comunicación con EDA por eventos (no Kafka personal)

**ADR:** [Usar Kafka como bus de eventos](https://g6d2.github.io/ADRs/ver.html?adr=usar-kafka-como-bus-de-eventos) (aceptada 2026-09-07; estado actual Hito 2 al 17/11/2026).

### Decisión

CityPass+ impone el **event gateway del Grupo 1** sobre Kafka. No se opera un broker propio fuera de `docker-compose` local. Alternativas descartadas en el ADR: RabbitMQ propio, webhooks HTTP punto a punto, polling REST entre módulos.

En Hito 1 también se evaluó Upstash / worker aparte (`docs/hosting-consumer-strategy.md`). En producción quedó:

- Broker compartido: `test.citypass.mrfranco.net.ar:9092` (SASL/OAUTHBEARER + SSL).
- Namespace: `com.citypass.emergencias.*` (token client-credentials `grupo5`).
- Avro + schema registry del gateway.
- Publicación por **gateway HTTP** (`EDA_PUBLISHER_MODE=gateway`): el backend manda solo `data`; el gateway sella `metadata`.
- Consumo **directo del broker** (no del gateway), in-process en el mismo servicio web.

### Qué se implementó

| Componente | Path | Rol |
|------------|------|-----|
| Outbox transaccional | `outbox_events` + `emergency.repository` | Mismo TX que el cambio de negocio |
| Outbox publisher | `src/services/outbox-publisher.js` | Poll, `FOR UPDATE SKIP LOCKED`, orden por emergencia, backoff si el bus cae |
| Gateway publisher | `src/services/gateway-publisher.js` | Publica `{metadata,data}` sellado Avro vía API del Grupo 1 |
| Kafka service | `src/services/kafka.service.js` | Modo `EDA_PUBLISHER_MODE=kafka` (dev/local) |
| Auth de servicio | `src/services/eda-auth-client.js` | Client-credentials para bus/gateway/registry |
| Builders de contrato | `src/services/emergency-events.js` | `EmergenciaCreada` / `Actualizada` (+ vínculo contexto) |
| Cifrado de ubicación en bus | `src/security/bus-location-crypto.js` | AES-256-GCM (`ELC…`), AAD por emergencia |
| Contrato | `asyncapi.yaml`, `docs/contratos/*.schema.json` | Spec vs builders |
| Consumer único | `src/listeners/event-consumer.js` | Un consumer para todos los tópicos (límite de conexiones) |

**Publicamos:** `EmergenciaCreada`, `EmergenciaActualizada` (y opcionalmente `EmergenciaVinculadaAContextoZona`). Entrega at-least-once; clave de partición = `correlationId`.

Variables clave: `KAFKA_*`, `EDA_OAUTH_*`, `EDA_API_URL`, `EDA_PUBLISHER_MODE`, `EDA_SCHEMA_REGISTRY_URL`, `OUTBOX_*`, `BUS_LOCATION_ENCRYPTION_KEY*`, `TOPIC_*` / `EDA_TOPIC_*`.

### Qué no hace el frontend

No hay WebSocket, SSE ni cliente Kafka en el front. Las pantallas hacen **polling REST** (~30 s) de `/api/emergencies` (y contextos de zona para alertas climáticas). El efecto EDA se ve como campos normales (`source`, `causaTipo`, actores `eda:*` en el historial).

---

## 3. Recibir eventos de otros equipos (no solo internos)

**ADRs:**
- [Consumir eventos externos con un listener y reglas por evento](https://g6d2.github.io/ADRs/ver.html?adr=consumir-eventos-externos-con-un-listener-y-reglas-por-evento)
- [Consumir todos los eventos externos con un solo consumer](https://g6d2.github.io/ADRs/ver.html?adr=consumir-todos-los-eventos-externos-con-un-solo-consumer) (aceptada 2026-11-16; PR #112)

### Problema

Antes el módulo se centraba en emergencias **internas** (ciudadano SOS / reporte). Para CityPass había que reaccionar a eventos de **Espacios, Movilidad y Reclamos** sin acoplar HTTP síncrono entre equipos. Analítica **no** publica eventos que consumamos: solo nos lee (ver §4).

### Framework de listeners

`src/listeners/` aporta:

- `event-listener.js`, `business-rule.js`, `load-rules.js`, `outcome-factory.js`
- Clasificación de errores (transitorio → redelivery; permanente → `DISCARDED`)
- Dedup por `metadata.eventId` en `eventos_procesados` (misma TX que el efecto)
- Supervisor / health por listener
- **Un solo** `EventConsumer` Avro para todos los tópicos (`group.id` = `com.citypass.emergencias.eventos`)

Motivo del consumer único: el broker del Grupo 1 limitaba ~**10 conexiones por IP**; con un consumer por listener (2 conexiones kafkajs c/u) al sumar ciclovía + bicicleta se saturaba y algunos listeners dejaban de leer aunque `/health` los mostrara “running”.

Documentación: `src/listeners/README.md`, `docs/diagramas/06-eventos.md`.

### Paquetes de integración externa

| Paquete | Equipo origen | Eventos | Efecto en Emergencias |
|---------|---------------|---------|------------------------|
| `cobertura-preventiva/` | Espacios | `EventoComunitarioPublicado`, `EventoCancelado`, `ActividadCreada`, `ReservaCreada` (opt-in) | Coberturas `PREVENTIVA` / baja |
| `alerta-climatica/` | Espacios | `CriticidadClimaticaConfirmada` / `Finalizada` (opt-in) | Contextos + `PREVENTIVA` climática |
| `movilidad-bicicleta/` | Movilidad | `EmergenciaBicicleta` | Emergencia externa `MEDICA` (`causaTipo=MOVILIDAD_BICICLETA`) |
| `reclamo-intervencion/` | Movilidad + Reclamos | `EmergenciaSolicitada`, `ReclamoCreado.v3`, `ReclamoActualizado` | Intervención `TRANSITO` + cancelación |

### Cambios específicos Reclamos / Movilidad (además del login)

| Cambio | Por qué | Referencia |
|--------|---------|------------|
| Disparador ciclovía: default `EmergenciaSolicitada` (Movilidad), no `ReclamoCreado` | Flujo acordado Reclamos → Movilidad evalúa → Emergencias; `ReclamoCreado` quedó plan B (`RECLAMO_INTERVENCION_DISPARADOR`) | ADR listeners, estado 17/11; back #93 → #100 |
| Tipo `TRANSITO` + índice único `uq_emergencies_reclamo_causa` | Una intervención por `reclamoId` aunque lleguen ambos disparadores o reintentos | V29, handlers reclamo |
| `ReclamoActualizado` final cancela solo en `PENDING`/`VALIDATED` | Si ya se despachó, no se tira abajo por cierre del reclamo | `ReclamoActualizadoListener` |
| `EmergenciaBicicleta` (otro caso de Movilidad) | Ayuda en viaje de bici pública → `MEDICA` externa; `correlationId` = `emergenciaId` de Movilidad; **no** reemplaza la ciclovía | ADR listeners; back #108 |
| Tabla de recursos / triage | Listener solo traduce campos; recursos los decide la tabla de reglas (también para disparadores externos); triage de Movilidad si `respondido` | ADR [Calcular los recursos requeridos…](https://g6d2.github.io/ADRs/ver.html?adr=calcular-los-recursos-requeridos-con-una-tabla-de-reglas) |
| Un solo consumer | Tras #93/#100/#108 había 5–6 consumers y se cortaban conexiones al broker | ADR un solo consumer |

Tópicos típicos (env): `com.citypass.movilidad.EmergenciaSolicitada`, `com.citypass.movilidad.EmergenciaBicicleta`, `com.citypass.reclamos.ReclamoCreado.v3`, `com.citypass.reclamos.ReclamoActualizado`, más Espacios; clima/reserva opt-in sin default.

### Garantías técnicas que hubo que sumar

| Mecanismo | Para qué |
|-----------|----------|
| Idempotencia por `eventId` | At-least-once del bus no duplica efectos |
| Unicidad de negocio (ej. por `reclamoId`/`causa`) | Dos disparadores o reintentos no crean dos intervenciones |
| `correlationId` / `causationId` | Trazar cadenas cross-módulo |
| Actores `eda:reclamos`, `eda:espacios` | Historial auditable distinto de un humano |
| `source=EXTERNAL` + `causaTipo`/`causaId` | Convención compartida (Analítica / front / bus) |
| Consumer group único | Offset compartido y reanudación tras sleep de Render |

En el front: `app/lib/emergencyOrigin.js`, `OriginInfo.js`, `displayText.js` (p. ej. “Reclamo ciclovía”, actores EDA).

---

## 4. Analítica y contrato de salida (no hay listener hacia Analítica)

**No consumimos eventos de Analítica.** Lo que publicamos al bus lo leen ellos (y Reclamos/Movilidad/…). El ADR de Kafka lo deja explícito: sin bus propio no hay forma de que Analítica use nuestros eventos sin tocar nuestro backend.

El tablero, al revés, lo pide el dispatcher: `GET /admin/analitica` reenvía su access token human a `GET /embed/emergencias` y devuelve ese HTML, sin modificarlo, para un iframe del mismo origen del frontend (`ANALITICA_EMBED_URL`).

Lo que sí hubo que implementar **en el contrato de publicación** para que Analítica (y el resto) pudieran usarnos:

| Pieza | Para quién / por qué | ADR / doc |
|-------|----------------------|-----------|
| Outbox + gateway + FQN `com.citypass.emergencias.*` | Sin publicar al bus compartido, Analítica no recibe nada | Kafka como bus |
| `causaTipo` / `causaId` | Convención de Analítica para origen externo (`RECLAMO`, `MOVILIDAD_BICICLETA`, `EVENTO_PUBLICO`, …) | Modelo ER / eventos |
| `barrio` en claro (catálogo CABA) | Reclamos escala por barrio y descarta sin barrio; Analítica/otros filtran por zona sin descifrar coords | [Guardar el barrio…](https://g6d2.github.io/ADRs/ver.html?adr=guardar-el-barrio-de-la-emergencia-al-crearla) |
| `latitud`/`longitud` aproximadas (3 decimales) en claro | Movilidad descartaba todas las `EmergenciaCreada` sin coords numéricas; Analítica guardaba ubicación `null`; Residuos/Espacios necesitan radio | [Publicar coordenadas aproximadas…](https://g6d2.github.io/ADRs/ver.html?adr=publicar-coordenadas-aproximadas-en-claro-en-los-eventos-del-bus) |
| `afectaCirculacion` derivado del tipo | Reclamos descarta el evento si es `false` (p. ej. `MEDICA`/`PANICO`) | `emergency-events.js`, guía bus-ubicación |
| Ubicación exacta cifrada en bus (`ubicacion.*`) | Opcional para quien tenga `BUS_LOCATION_ENCRYPTION_KEY`; la mayoría no descifra | Guía consumidores |
| Recursos en `EmergenciaActualizada` (+ un evento por recurso al despachar) | Pedido de Analítica (contrato 2026-10-29): campo en cambio de estado, no un tipo por recurso | [Informar los recursos requeridos…](https://g6d2.github.io/ADRs/ver.html?adr=informar-los-recursos-requeridos-como-un-campo-del-cambio-de-estado) |
| `EmergenciaVinculadaAContextoZona` (opt-in) | Analítica cuenta vínculos con `GROUP BY` sin recalcular geometría; hoy apagado hasta registrar el tipo en el gateway | [Publicar el vínculo…](https://g6d2.github.io/ADRs/ver.html?adr=publicar-el-vinculo-de-una-emergencia-con-un-contexto-de-zona) |

Guías autocontenidas para otros equipos: `docs/bus-ubicacion-para-consumidores.md`, `docs/prioridad-por-contexto-para-consumidores.md`.

---

## Mapa rápido: qué pieza resuelve qué

```
Ciudadano (local JWT) ──HTTP──► Backend ──outbox──► Gateway EDA ──► Analítica / Reclamos / Movilidad / …
Personal (IdP JWT)    ──BFF──► Backend (hybrid verify)
                                                              ▲
Reclamos / Movilidad / Espacios ──Kafka Avro──► EventConsumer ─┘
Backend ──client-credentials (Login Federado)──► bus / gateway / registry
```

| Necesidad | Implementación principal |
|-----------|--------------------------|
| Login del otro repo (personal) | Front BFF LDAP + back `AUTH_MODE=hybrid` + JWKS |
| Ciudadanos sin IdP | Tokens locales + rutas `/auth/*` |
| Acceso al bus (leer Reclamos/Movilidad y publicar) | `eda-auth-client` (OAuth servicio) |
| Operar emergencias nacidas de reclamos | Grupos federados + authorize + UI ops |
| No usar Kafka propio | Outbox + gateway Grupo 1 + AsyncAPI |
| Eventos de otros equipos | Listeners Avro + un solo consumer + dedup |
| Que Analítica (y pares) nos puedan consumir | Contrato: barrio, coords ~100 m, causa, `afectaCirculacion`, recursos |
| Ver el tablero de Analítica | `GET /admin/analitica` (proxy del HTML, Bearer human) |

---

## ADRs más relevantes

| Tema | ADR |
|------|-----|
| Login híbrido | [Usar el Login Federado…](https://g6d2.github.io/ADRs/ver.html?adr=usar-el-login-federado-para-el-personal-y-cuentas-locales-para-los-ciudadanos) |
| Bus EDA | [Usar Kafka como bus de eventos](https://g6d2.github.io/ADRs/ver.html?adr=usar-kafka-como-bus-de-eventos) |
| Listeners | [Consumir eventos externos…](https://g6d2.github.io/ADRs/ver.html?adr=consumir-eventos-externos-con-un-listener-y-reglas-por-evento) |
| Un solo consumer | [Consumir todos los eventos… con un solo consumer](https://g6d2.github.io/ADRs/ver.html?adr=consumir-todos-los-eventos-externos-con-un-solo-consumer) |
| Barrio / coords para consumidores | [Guardar el barrio…](https://g6d2.github.io/ADRs/ver.html?adr=guardar-el-barrio-de-la-emergencia-al-crearla) · [Coords aproximadas…](https://g6d2.github.io/ADRs/ver.html?adr=publicar-coordenadas-aproximadas-en-claro-en-los-eventos-del-bus) |
| Recursos (Movilidad + Analítica) | [Calcular recursos…](https://g6d2.github.io/ADRs/ver.html?adr=calcular-los-recursos-requeridos-con-una-tabla-de-reglas) · [Informar recursos…](https://g6d2.github.io/ADRs/ver.html?adr=informar-los-recursos-requeridos-como-un-campo-del-cambio-de-estado) |
| Vínculo zona → Analítica | [Publicar el vínculo…](https://g6d2.github.io/ADRs/ver.html?adr=publicar-el-vinculo-de-una-emergencia-con-un-contexto-de-zona) |

## Referencias de repo

- Backend README: Login Federado / Eventos bus EDA / Consumo de eventos externos / ADRs relacionados
- Frontend README: BFF auth, LDAP, polling
- `docs/diagramas/00-contexto.md`, `03-arquitectura.md`, `05-secuencias.md`, `06-eventos.md`, `08-despliegue.md`
- `docs/hosting-consumer-strategy.md`, `docs/bus-ubicacion-para-consumidores.md`
- `asyncapi.yaml`, `src/listeners/README.md`
