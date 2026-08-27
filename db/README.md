# Persistencia de emergencias (Task 4)

Fuente de verdad del schema: **Git + migrations**, no la consola de Supabase. Cualquier
cambio de schema entra como un nuevo archivo `V{n}__descripcion.sql` en `db/migrations/`.

## Decisiones de diseño

- **`user_id` en vez de `ciudadano_id` con FK**: hoy el botón de pánico (Task 2) solo
  tiene `payload.userId`, un string sin autenticación (no hay JWT/Login Federado
  todavía). Se guarda tal cual, sin FK a una tabla de usuarios que no existe. Cuando
  el módulo de Auth esté listo, se podrá agregar la FK en una migration nueva sin
  romper lo existente.
- **`latitude`/`longitude` como columnas simples, no PostGIS**: el caso de uso actual
  solo necesita guardar y devolver el punto, no hacer queries geoespaciales. Se evita
  la dependencia de PostGIS hasta que sea indispensable.
- **`status` es `TEXT NOT NULL DEFAULT 'PENDIENTE'`, sin `CHECK`**: esta task solo deja
  persistido el estado y su historial. La máquina de estados completa (qué
  transiciones son válidas) es de Task 9; agregar un `CHECK` acá hubiera anticipado
  esa lógica.
- **`actor`/`motivo` nullable en el historial**: sin Auth no siempre hay un actor
  identificable, y no todo cambio de estado tiene un motivo explícito.

## Tablas

- `emergencias`: una fila por emergencia (id, user_id, latitude, longitude,
  description, severity, status, created_at, updated_at).
- `emergencia_estado_historial`: una fila por cada cambio de estado
  (emergencia_id, estado_anterior, estado_nuevo, actor, motivo, created_at).

## Cómo correr las migrations

No hace falta instalar el CLI de Flyway: se ejecuta vía Docker (imagen
`flyway/flyway:10-alpine`), que ya se usa en este proyecto para Kafka/Zookeeper.

```bash
# 1. Copiar .env.example a .env y completar DATABASE_URL con la connection string
#    real de Supabase (Settings > Database > Connection string > URI).
cp .env.example .env

# 2. Aplicar las migrations pendientes
npm run migrate

# Ver el estado de las migrations sin aplicar nada
npm run migrate:info
```

Flyway detecta automáticamente qué migrations ya se aplicaron (tabla
`flyway_schema_history`, creada por él mismo) y solo corre las nuevas. Volver a
ejecutar `npm run migrate` es seguro (no reintenta migrations ya aplicadas).

### Verificar que las tablas se crearon

Desde `psql` (o el SQL editor de Supabase):

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('emergencias', 'emergencia_estado_historial', 'flyway_schema_history');
```

## Cómo probar el repository

`EmergencyRepository` (`src/repositories/emergency.repository.js`) se prueba con
tests de integración reales (no mocks) contra Postgres:

```bash
npm run test:integration
```

Este comando levanta automáticamente un contenedor Postgres efímero + corre las
migrations con Flyway + ejecuta los tests + destruye el contenedor al final. No
requiere tocar la base de Supabase ni tener nada corriendo de antemano (solo Docker).

Si en cambio querés correr los tests contra una base propia (por ejemplo un branch
de Supabase dedicado a testing), definí `TEST_DATABASE_URL` antes de correr el
comando; en ese caso no se orquesta ningún contenedor, solo se aplican las
migrations contra esa URL y se corren los tests ahí.

## Pendiente para Task 2 (botón de pánico)

`EmergencyRepository` queda listo para ser inyectado donde hoy
`PanicButtonController` usa el `Map` en memoria. Puntos a resolver en esa
integración (no se tocó nada de Task 2 desde esta rama):

1. Mapear `payload.location.lat/lng` → `latitude/longitude` al llamar a
   `repository.create(...)`.
2. El controller hoy setea `status: 'creada'`; esta capa usa `'PENDIENTE'` como
   estado inicial (según la historia de Task 4). Conviene alinear el valor que usa
   el controller a `'PENDIENTE'` al integrar.
3. Inyectar `EmergencyRepository` (con un `pool` de `src/db/pool.js`) al controller,
   siguiendo el mismo patrón que ya existe para `kafkaService` en `index.js`.
