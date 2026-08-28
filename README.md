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

# O sin Docker
npm run dev
```

### Verificar que funciona

```bash
curl http://localhost:3000/health
```

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
