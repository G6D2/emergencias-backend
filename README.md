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

El POST de panic button guarda `emergencyId` solo para los requests siguientes.

El health check reporta el estado de Kafka (`connected`/`disconnected`). Ojo: `connected` solo indica que el producer se conectó — ver la sección de Kafka para una trampa conocida al publicar desde el host.

---

## API Endpoints

### POST `/api/panic-button`

Activa el botón de pánico.

**Request:**
```json
{
  "userId": "user-123",
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
    "userId": "user-123",
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

Obtiene detalles de un evento de pánico.

### PATCH `/api/emergencies/:id/cancel`

Cancela una emergencia en estado `PENDING` o `VALIDATED`.

**Request:**
```json
{
  "actor": "user-123",
  "reason": "Falsa alarma"
}
```

### GET `/health`

Estado del servicio y conectividad Kafka.

---

## Arquitectura

```
src/
├── index.js                      # Composition root (Kafka + pool + app)
├── app.js                        # Express factory (inyectable en tests)
├── swagger.js                    # OpenAPI 3 + Swagger UI (/api-docs)
├── controllers/
│   ├── panic-button.controller.js
│   └── emergency.controller.js
├── routes/
│   ├── panic-button.routes.js
│   └── emergencies.routes.js
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
- [ ] Integración con Login Federado (auth)
- [ ] Alinear contrato HTTP de location (`lat`/`lng` vs `latitude`/`longitude`)
