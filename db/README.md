# Persistencia de emergencias

La fuente de verdad del schema es **Git + migrations Flyway** en `db/migrations/`.
El entry point del pipeline (`src/db/migrate.js` y la carpeta `migrations/`)
apunta al mismo flujo; no hay un segundo runner por ahí.

Cualquier cambio de schema entra como un archivo nuevo `V{n}__descripcion.sql`
en `db/migrations/`.

### Outbox de eventos

Las operaciones que crean una emergencia o cambian su estado guardan el evento
en `outbox_events` dentro de la misma transacción que modifica la emergencia.
Un worker del backend publica los eventos pendientes en Kafka y los reintenta
si el broker está temporalmente caído. Por eso Kafka no forma parte de la
transacción HTTP y una caída del broker no deja la base en un estado sin evento
recuperable.

Después de incorporar `V6__create_outbox_events.sql`, ejecutar:

```bash
npm run migrate
```

Los eventos se marcan como `PUBLISHED` solo después de que Kafka confirma el
envío. El outbox proporciona entrega al menos una vez; los consumidores deben
usar `event.id` o `emergencyId` para hacer sus operaciones idempotentes.

Los eventos fallidos usan backoff exponencial hasta `OUTBOX_MAX_ATTEMPTS`
(default: 10); después pasan a `FAILED` para evitar reintentos infinitos.
Las filas `PUBLISHED` se purgan después de `OUTBOX_PUBLISHED_RETENTION_HOURS`
(default: 168 horas). Con `KAFKA_ENABLED=false`, los eventos permanecen
`PENDING` hasta que exista un broker y se habilite el publisher.

## Decisiones de diseño

- **`user_id` sin FK**: el panic button solo manda `payload.userId` (todavía no hay Auth).
- **`latitude`/`longitude` (sin PostGIS)**: por ahora solo guardamos y devolvemos el punto.
- **`status` TEXT NOT NULL**, sin CHECK: las transiciones las valida la app
  (ej. cancelar solo desde `PENDING` o `VALIDATED`).
  V1 dejó el `DEFAULT` en `'CREATED'` (valor histórico, ya no forma parte del
  vocabulario de estados); V5 lo cambia al vigente, `'PENDING'`.
- **`causas_relacionadas` TEXT[] NOT NULL**: causas declaradas por el oficial
  al resolver; el evento de actualización las publica y conserva al cerrar.
- **`actor`/`reason` nullable** en el historial: Auth pendiente; no todo cambio tiene motivo.

## Tablas

- `emergencies`: una fila por emergency.
- `emergency_status_history`: una fila por cambio de status
  (`emergency_id`, `previous_status`, `new_status`, `actor`, `reason`, `created_at`).

## Cómo correr las migrations

```bash
cp .env.example .env
# Pegá en DATABASE_URL la connection string de Neon (Dashboard → Connect)
# y dejá DATABASE_SSL=true

npm run migrate
npm run migrate:info
```

Flyway pega contra esa misma `DATABASE_URL` (Neon, local o el secret del CD).

### Verificar tablas

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('emergencies', 'emergency_status_history', 'flyway_schema_history');
```

## Cómo probar el repository

```bash
npm run test:integration
```

Si definís `TEST_DATABASE_URL`, usa esa base y no levanta contenedor.
