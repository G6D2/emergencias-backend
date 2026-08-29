# Migrations (historial del pipeline CI/CD)

El SQL original del pipeline vivía acá y ahora corre con **Flyway** en
`db/migrations/`:

| Pipeline (viejo) | Flyway (actual) |
|------------------|-----------------|
| `migrations/001_create_emergencies_table.sql` | `db/migrations/V1__create_emergencias.sql` |
| tabla `emergencies`, cols `lat`/`lng` | tabla `emergencies`, cols `latitude`/`longitude` |
| status default `creada` | status default `CREATED` |
| tabla custom `_migrations` | Flyway `flyway_schema_history` |

## Cómo correr migrations

```bash
npm run migrate
# equivalente:
node src/db/migrate.js
node scripts/migrate.js migrate
```

Más detalle en [db/README.md](../db/README.md).
