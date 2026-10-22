# Schemas Avro para el gateway EDA

Esta carpeta contiene los schemas de los event types que publicamos en
`com.citypass.emergencias.*`. El script `scripts/register-event-types.js`
los registra en el gateway via `POST /api/v1/event-types`.

## Convención de archivos

| Extensión | Qué es | ¿El script lo registra? |
|---|---|---|
| `*.avsc.json` | Schema cerrado y acordado con todos los consumidores | sí |
| `*.avsc.json.draft` | Schema propuesto, pendiente de acordar | no |

El script usa `glob('schemas/eda/*.avsc.json')` — los `.draft` quedan
intactos hasta que se les saque el sufijo.

## Estado actual

- `EmergenciaReportada.v2.avsc.json.draft` — propuesto por nosotros, acordado
  con Facundo (gateway EDA). **Bloqueado:** Analítica (Grupo 8) tiene un
  catálogo propuesto que no matchea completamente. Hay que cerrar la diferencia
  antes de renombrar a `.avsc.json` y correr el script.

## Flujo de uso

```bash
# Setear las variables mínimas (ver .env.example sección Integración EDA):
export EDA_API_URL=http://localhost:8080
export EDA_AUTH_URL=http://localhost:8083/oauth/token
export EDA_CLIENT_ID=grupo5
export EDA_CLIENT_SECRET=grupo5

# Registrar todos los schemas .avsc.json de esta carpeta (idempotente)
node scripts/register-event-types.js
```

Un `400 "existe un event type"` se trata como OK (ya está registrado).
Cualquier otro error frena el script con exit 1.
