# Prioridad elevada cerca de eventos públicos

> **Reemplazado por [ADR #28 — Elevar temporalmente la prioridad con contextos de zona](https://github.com/G6D2/ADRs/blob/main/adr/elevar-temporalmente-la-prioridad-con-contextos-de-zona.md) (aceptado 2026-11-05).**
>
> El diseño de este documento (tabla `priority_zones` con `latitude`, `longitude`, `radius_meters` y cálculo de distancia Haversine) fue evaluado como **alternativa F** en el ADR y descartado. Las razones principales: descifra ubicaciones en cada lectura, exige definir un radio por tipo de evento que no existe para alertas climáticas, y requiere la misma tabla de barrios que se necesita para los otros módulos de todas formas.
>
> El mecanismo adoptado usa una tabla `contexto_zona` indexada por **barrio** (string), sin geometría. **Todavía no está implementado**: depende de que la emergencia guarde el barrio ([ADR — Guardar el barrio de la emergencia al crearla](https://github.com/G6D2/ADRs/blob/main/adr/guardar-el-barrio-de-la-emergencia-al-crearla.md)), que tampoco está hecho.
>
> No confundir con la **cobertura preventiva** (`src/listeners/cobertura-preventiva/`), que sí existe: ante un `EventoComunitarioPublicado` de Espacios con capacidad ≥ 500 crea una emergencia `PREVENTIVA`, pero no cambia la prioridad de otras emergencias. Este documento queda como registro histórico del diseño descartado.

**Estado:** reemplazado — ver ADR #28
**Contexto:** primer caso de negocio sobre el paquete `src/listeners/` (EventListener + reglas)

## Requisito

Cuando llega un evento `PublicEvent` (con fecha y ubicación), las emergencias nuevas creadas
cerca de ese evento **mientras está ocurriendo** se muestran con la prioridad elevada un nivel.

- La prioridad guardada en la base (`emergencies.severity`) **no cambia**: el aumento es un
  cálculo en tiempo de lectura.
- Cuando el evento termina, se cancela o se modifica, las prioridades vuelven a la normalidad
  (o se recalculan) sin escribir nada en `emergencies`.

## Diseño en dos mitades

El listener no puede tocar emergencias que todavía no existen. Su trabajo es dejar registrada
una **zona prioritaria**; la lectura de emergencias es la que la consulta.

### 1. Escuchar y registrar (paquete `listeners`)

```
src/listeners/eventos-publicos/
  index.js                          # listeners: [PublicEventListener, ...]
  public-event/
    public-event.listener.js        # topic: EDA_TOPIC_PUBLIC_EVENT, rulesDir: ./rules
    rules/
      registrar-zona-prioritaria.rule.js
```

- Agregar `eventos-publicos` a `PACKAGES` en `src/listeners/index.js` y
  `EDA_TOPIC_PUBLIC_EVENT` a `.env.example`.
- Cancelaciones y modificaciones: un listener por tipo de evento en el mismo paquete (o el
  mismo listener si el productor las publica en el mismo topic), cada uno con sus reglas.

**Reglas.** El payload viene de otro sistema: `appliesTo()` valida antes de aplicar.

| Regla | `appliesTo` | `apply` devuelve |
|---|---|---|
| Registrar / actualizar | lat/lng numéricos en rango, inicio y fin válidos, fin > inicio, fin no pasado, timestamp de origen válido | `{ type: 'ActualizarZonaPrioritaria', payload: { publicEventId, latitude, longitude, radiusMeters, startsAt, endsAt, sourceUpdatedAt } }` |
| Cancelar | `publicEventId` y timestamp de origen válidos | `{ type: 'CancelarZonaPrioritaria', payload: { publicEventId, sourceUpdatedAt } }` |

**Radio por regla.** No hay un radio global por default: cada regla define el suyo según el
tipo de evento que cubre (p. ej. un recital 800 m, una feria 300 m) y lo manda en
`radiusMeters`. Tipos de evento distintos son reglas distintas, cada una con su radio. La zona
guarda el radio con el que se creó, así que cambiar una regla solo afecta a las zonas nuevas o
actualizadas.

### 2. Persistir la zona (factory)

Migración `V<n>__create_priority_zones.sql` (la siguiente libre; V17 a V23 ya están tomadas o reservadas):

| Columna | Notas |
|---|---|
| `public_event_id` | único (clave de upsert) |
| `latitude`, `longitude`, `radius_meters` | en claro: la ubicación de un evento público no es dato personal (a diferencia de las emergencias, cifradas desde V3). Nullable para soportar un cancel que llega antes que el alta. |
| `starts_at`, `ends_at` | nullable por el mismo motivo; índice `(starts_at, ends_at)` |
| `source_updated_at` | timestamp **del productor**, no el de recepción |
| `cancelled_at` | cancelación lógica (no se borra la fila) |

**Orden de llegada.** Kafka puede reentregar y desordenar. Toda escritura aplica solo si es
más nueva que lo guardado:

```sql
-- Alta / modificación
INSERT INTO priority_zones (public_event_id, latitude, longitude, radius_meters,
                            starts_at, ends_at, source_updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (public_event_id) DO UPDATE
  SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
      radius_meters = EXCLUDED.radius_meters, starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at, source_updated_at = EXCLUDED.source_updated_at
  WHERE priority_zones.source_updated_at < EXCLUDED.source_updated_at
    AND priority_zones.cancelled_at IS NULL;

-- Cancelación (también upsert: funciona si llega antes que el alta)
INSERT INTO priority_zones (public_event_id, source_updated_at, cancelled_at)
VALUES ($1, $2, now())
ON CONFLICT (public_event_id) DO UPDATE
  SET cancelled_at = now(), source_updated_at = EXCLUDED.source_updated_at
  WHERE priority_zones.source_updated_at < EXCLUDED.source_updated_at;
```

| Llega | Resultado |
|---|---|
| Duplicado (mismo timestamp) | Ignorado (`<` no se cumple con valores iguales) |
| Update viejo después de uno nuevo | Ignorado |
| Update después de un cancel | Ignorado: la zona sigue cancelada |
| Cancel antes del alta | Queda una fila ya cancelada; el alta tardía se ignora |
| Update nuevo después de uno viejo | Aplicado; el aumento se recalcula en la próxima lectura |

Una escritura descartada por vieja es un resultado normal: se loguea y **no** se lanza error
(si no, Kafka reentrega para siempre un mensaje que nunca va a aplicar).

### 3. Aumento en tiempo de lectura (sin escrituras en `emergencies`)

En `findPage` y `findDetailById` (`src/repositories/emergency.repository.js`):

1. **Zonas activas:** `cancelled_at IS NULL AND starts_at <= now() AND now() <= ends_at`.
   Normalmente no hay ninguna y el costo es esa sola consulta (se puede cachear en memoria
   ~1 minuto).
2. **Emergencias con aumento:** si hay zonas activas, se buscan solo las candidatas
   (`created_at >= zone.starts_at`), se descifran sus coordenadas en la aplicación y se
   compara la distancia con `haversineDistanceMeters` (`src/domain/rule-based-grouper.js`).
   El resultado es una lista corta de ids. No se cargan todas las emergencias.
3. **Orden en SQL** con esa lista como parámetro, para que paginar siga siendo correcto:
   ```sql
   GREATEST(
     LEAST(rank(e.severity) + CASE WHEN e.id = ANY($boosted) THEN 1 ELSE 0 END, 4),
     rank(i.priority))
   ```
4. **Prioridad mostrada:** `effectivePriority(severity, incidentPriority, boosted)` en
   `src/domain/severity.js` sube `severity` un nivel (tope `critical`) antes de tomar el
   máximo con la del incidente. Nueva función pura `elevateOneLevel(level)`.

Cuando el evento termina o se cancela, el paso 1 no devuelve la zona, la lista queda vacía y
todo vuelve a la normalidad en la próxima lectura. Las zonas vencidas se pueden limpiar con un
job o dejarse: inactivas se ignoran.

## Tests

- Reglas: evento válido, sin coordenadas, fin antes del inicio, evento ya terminado,
  timestamp faltante o inválido.
- Factory: un test por fila de la tabla de orden de llegada.
- Dominio: justo dentro / fuera del radio; antes, durante y después de la ventana;
  `critical` sigue `critical`.
- Repository: con zona activa la emergencia cercana se muestra y se ordena con el aumento;
  sin zona activa, no.

## Pendiente de definir

- **Contrato del payload** con el equipo productor: id del evento, coordenadas, inicio y fin,
  nombres de campo, y el **timestamp/versión de origen en cada mensaje** (alta, modificación
  y cancelación).
- **Radio en metros de cada tipo de evento** (uno por regla), y qué campo del payload indica
  el tipo de evento.
- **Qué emergencias suben:** solo las creadas durante el evento (lectura actual de "nuevas")
  o cualquier emergencia abierta cerca de él. El diseño soporta ambas: cambia el criterio de
  candidatas en el paso 2 (`created_at` vs. estado no cerrado).
- **Eventos superpuestos:** se asume que suben un solo nivel, no uno por evento.
- Las emergencias `PANICO` ya son `critical`: el aumento solo afecta a los demás tipos.
- La factory ya existe (`src/listeners/outcome-factory.js`): ejecuta los resultados
  `{ type, payload }` en una transacción con dedup por `eventId`. Para este caso falta
  registrar los handlers `ActualizarZonaPrioritaria` y `CancelarZonaPrioritaria`.
