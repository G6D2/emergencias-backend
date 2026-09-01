# Emergencias Backend

**CityPass+ - Módulo de Emergencias y Seguridad**

## 📋 Descripción

Backend para el módulo de Emergencias y Seguridad de CityPass+. Gestiona botones de pánico, alertas críticas y priorización de eventos.

## 🎯 Caso de Uso 2: Botón de Pánico

**Objetivo:** Permitir que ciudadanos activen un botón de pánico que genere una emergencia crítica.

### Flujo
1. Usuario activa botón de pánico en la app mobile/web
2. Sistema genera evento de emergencia con ID único
3. Evento se publica en Kafka (`emergencias.boton-panico`)
4. Operadores pueden visualizar la emergencia en tiempo real

---

## 🚀 Inicio Rápido

### Requisitos
- Node.js 18+
- Docker & Docker Compose

### Instalación Local

```bash
# Clonar repo
git clone https://github.com/G6D2/emergencias-backend.git
cd emergencias-backend

# Instalar dependencias
npm install

# Copiar variables de entorno
cp .env.example .env

# Iniciar con Docker Compose (recomendado)
docker-compose up
```

**Sin Docker (backend en el host):**

```bash
# npm install local es obligatorio aunque ya exista node_modules/:
# si las dependencias se instalaron desde el contenedor (Linux), en el host faltan o no sirven.
npm install

# En .env: apuntar Kafka al listener del host (NO al de Docker, ver sección Kafka más abajo)
#   KAFKA_BROKER=localhost:29092
# Si 3000/3001 están ocupados, elegir otro puerto:
#   PORT=4000

# Levantar solo la infraestructura de Kafka en Docker
docker compose up -d kafka

npm run dev
```

### Verificar que funciona

```bash
# Reemplazar 3000 por el PORT configurado en .env
curl http://localhost:3000/health
```

El health check reporta el estado de Kafka (`connected`/`disconnected`). Ojo: `connected` solo indica que el producer se conectó — ver la sección de Kafka para una trampa conocida al publicar desde el host.

---

## 💡 API Endpoints

### POST `/api/panic-button`

Activa el botón de pánico.

**Request:**
```json
{
  "userId": "user-123",
  "location": {
    "lat": -34.6037,
    "lng": -58.3816
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
    "location": { "lat": -34.6037, "lng": -58.3816 },
    "description": "Necesito ayuda inmediata",
    "severity": "critical",
    "timestamp": "2026-08-25T10:00:00Z",
    "status": "creada"
  }
}
```

### GET `/api/panic-button/:id`

Obtiene detalles de un evento de pánico.

**Response:**
```json
{
  "success": true,
  "data": { /* emergency data */ }
}
```

---

## 🏗️ Arquitectura

```
src/
├── index.js                 # Entry point
├── services/
│   └── kafka.service.js     # Kafka producer/consumer
├── controllers/
│   └── panic-button.controller.js  # Lógica de negocio
├── routes/
│   └── panic-button.routes.js      # Endpoints
└── tests/
    └── panic-button.test.js        # Tests
```

---

## 🗄️ Persistencia (PostgreSQL / Supabase)

Las emergencias y su historial de cambios de estado se persisten en PostgreSQL
(hosteado en Supabase) mediante `pg` y migrations versionadas con Flyway. Ver
[db/README.md](db/README.md) para el detalle del schema, cómo correr las
migrations y cómo probar el repository.

---

## 📊 Kafka Topics

- `emergencias.boton-panico`: Eventos de botón de pánico
- `emergencias.creada`: Emergencias creadas

---

## ⚠️ Kafka: `kafka:9092` vs `localhost:29092`

El broker del `docker-compose.yml` expone **dos listeners**, y hay que usar el correcto según desde dónde corre el cliente:

| Cliente | Broker a usar |
|---|---|
| Proceso dentro de la red de Docker (ej. el backend de compose) | `kafka:9092` |
| Proceso en el host (ej. `npm run dev`) | `localhost:29092` |

**Trampa conocida:** si desde el host usás `localhost:9092`, la conexión inicial funciona (el health check dice `kafka: connected`) pero al publicar un evento el request queda colgado, con `getaddrinfo ENOTFOUND kafka` repetido en el log. Pasa porque en el handshake el broker les "anuncia" a sus clientes la dirección `kafka:9092`, un hostname que solo resuelve dentro de Docker. El listener `PLAINTEXT_HOST` del puerto `29092` anuncia `localhost:29092` y evita el problema.

---

## 🧪 Testing

```bash
# Ejecutar tests
npm test

# Con cobertura
npm test -- --coverage
```

---

## 📝 ADRs Relacionados

- [ADR-001: Event-Driven Architecture](../ADRs/)
- [ADR-002: Kafka vs RabbitMQ](../ADRs/)

---

## 👥 Equipo

- **Backend:** Matías, Lucca
- **Security:** Valentina
- **DevOps:** Kevin
- **PM:** Juani
- **Frontend:** Santino
- **Scrum Master:** Sebastián

---

## 📋 Próximos Pasos

- [x] ID 4: Persistencia de emergencias (PostgreSQL)
- [ ] ID 3: Visualización en tiempo real (WebSockets)
- [ ] Integración con grupo de Login Federado
- [ ] Tests de integración con otros módulos
