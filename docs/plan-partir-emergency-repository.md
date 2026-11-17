# Plan para partir `EmergencyRepository`

> **Estado:** plan, sin código. Sale de una revisión interna del equipo del 17/11/2026 (una
> corrección simulada con la consigna y la rúbrica, no la de la cátedra), que marcó que
> `src/repositories/emergency.repository.js` tiene ~1.485 líneas (1.507 después del #134). No se
> ejecuta antes de la entrega del 26/11 (ver [Por qué no antes del 26/11](#por-qué-no-antes-del-2611)).

## Qué responsabilidades conviven hoy

Son nueve, en una sola clase y sus helpers. Los rangos son de `main` al 17/11/2026, con el #134
(commit `3383250`).

| Responsabilidad | Líneas | Métodos o piezas | Quién la usa |
|---|---|---|---|
| Mapeo de filas a objetos | 47–150, 212–244, 259–281 | `mapEmergency` (descifra la ubicación), `mapIncidentSummary`, `mapZoneContext`, `mapEmergencyWithIncident`, `mapHistoryEntry`, `mapAccessAudit`, aviso único de ubicación indescifrable (`Set` del proceso) | todas las lecturas y mutaciones |
| Fragmentos SQL compartidos | 21–45, 152–210, 246–257, 283–311 | último cambio de estado, cobertura preventiva vigente, columnas de los candidatos del job, JOIN de incidente, contexto de zona en curso, scope del oficial, `INSERT_SQL`, reserva de `Idempotency-Key` | lecturas, alta y expiración |
| Alta e `Idempotency-Key` | 325–472 | `create`, `createWithIdempotencyKey`, `findIdempotentResult`, `purgeExpiredIdempotencyKeysIfDue` | `panic-button.controller`, 4 handlers de listeners |
| Contexto de zona | 474–612, 916–932 | `linkZoneContexts` (vínculo y evento en una sola sentencia), `enqueueMissingZoneContextLinkEvents`, `unlinkZoneContexts` | `create`, retención, `scripts/backfill-vinculos-contexto.js` |
| Outbox | 614–624, 872–914, 1133–1176 | `insertOutboxEvent`, `scrubOutboxBusCoordinates`, `findOutboxPage` | todas las mutaciones, `incident.repository`, `outbox.routes` |
| Lecturas | 626–677, 1044–1131, 1307–1405 | `findById`, `findHistoryByEmergencyId`, `findDetailById`, `recordAccess` (auditoría), `findPage`, `findByCausa`, `findRecentByType`, `findActiveByIncidentIds` (con `toDetectionCandidates`) | `emergency.controller`, handlers, `incident-detection-job` |
| Ciclo de vida | 1178–1305, 1407–1504 | `updateStatus`, `applyStatusUpdate`, `setIncidentId`, `assignOfficer` | `emergency.controller`, handlers, `expireOne`, `incident.repository` |
| Retención y saneo de ubicación | 679–771, 934–1042 | `anonymizeExpiredLocations`, `anonymizeLocationRow`, `anonymizeUndecryptableLocations`, `backfillBarrios` | job de retención, `scripts/anonymize-locations.js`, `scripts/backfill-barrios.js` |
| Expiración | 773–870 | `expireStaleEmergencies`, `expireOne` | `emergency-expiration-job` |

El **cifrado** no es un bloque: está repartido. `create` cifra (339–341) y cinco lugares descifran,
cada uno con su política ante un ciphertext roto: `mapEmergency` avisa una vez y devuelve sin
ubicación (84–97), `anonymizeLocationRow` anonimiza sin barrio (742–753),
`anonymizeUndecryptableLocations` lo usa como criterio (944–954), `backfillBarrios` saltea la fila
(1006–1018) y `toDetectionCandidates` la excluye del job de incidentes (1380–1390).

Las dependencias internas son las que complican el corte:

- `create` llama a `linkZoneContexts` y a `insertOutboxEvent` con el mismo `client`.
- `expireOne` llama a `anonymizeLocationRow` y a `applyStatusUpdate` dentro de **su** transacción.
- `anonymizeExpiredLocations`, `anonymizeUndecryptableLocations` y `expireStaleEmergencies` terminan
  en `unlinkZoneContexts` y `scrubOutboxBusCoordinates`.
- `incident.repository` usa `insertOutboxEvent` y `setIncidentId` de esta clase.

## Cómo partirlo

Una carpeta `src/repositories/emergency/` con un módulo por responsabilidad, y
`emergency.repository.js` como **fachada**: la misma clase, con los mismos métodos públicos, que
delega. Nada de afuera cambia en la primera etapa.

```
src/repositories/emergency/
  emergency-row-mapper.js     # map*, aviso de indescifrables (puro, sin pool)       ~210 líneas
  emergency-sql.js            # fragmentos SQL compartidos                           ~80
  emergency-outbox.js         # insertOutboxEvent, scrubOutboxBusCoordinates, findOutboxPage  ~110
  zone-context-links.js       # linkZoneContexts, unlinkZoneContexts, backfill de eventos     ~150
  emergency-creation.js       # create, createWithIdempotencyKey, purga de claves             ~160
  emergency-lifecycle.js      # updateStatus, applyStatusUpdate, assignOfficer, setIncidentId ~220
  emergency-queries.js        # findById, findDetailById, findPage, findByCausa, candidatos del job, recordAccess  ~270
  location-anonymizer.js      # anonimizaciones y backfillBarrios                    ~200
  emergency-expiration.js     # expireStaleEmergencies, expireOne                    ~110
src/repositories/emergency.repository.js   # fachada                                 ~90
```

Cada módulo es una clase que recibe sus dependencias explícitas en el constructor:
`{ pool, locationCrypto, env }` y, si las necesita, las otras piezas (`outbox`, `zoneLinks`,
`lifecycle`, `anonymizer`). `mapEmergency` se sigue exportando desde `emergency.repository.js`.

**Composition root.** `src/index.js` hoy hace `new EmergencyRepository(pool, { locationCrypto })` y
reparte esa instancia a `createApp`, a los handlers del `OutcomeFactory`, a los tres jobs y a
`IncidentRepository`. En la etapa A eso no cambia: el constructor de la fachada arma los módulos con
el mismo `pool`, el mismo `locationCrypto` y el mismo `env`. En la etapa B, opcional, `index.js` arma
los módulos y le pasa a cada consumidor solo el que usa: el job de retención recibe
`location-anonymizer`, el de expiración `emergency-expiration`, `outbox.routes` e
`IncidentRepository` reciben `emergency-outbox` (y este último `emergency-lifecycle` para
`setIncidentId`), los handlers reciben creación, ciclo de vida y lecturas. La fachada queda para los
controllers o desaparece al final.

Regla para todos los pasos: **mover, no reescribir**. El SQL y el orden de las queries quedan
idénticos; `git diff --color-moved=zebra` tiene que mostrar casi todo como bloques movidos.

## En qué orden y con qué tests de red

**Paso 0, antes de mover nada** (un PR chico):

- Test de arquitectura en `src/tests/architecture/`: fija la lista ordenada de métodos públicos de
  `EmergencyRepository.prototype` (que la fachada no pierda ninguno) y un tope de líneas por
  archivo de `src/repositories/emergency/` (por ejemplo 300).
- Test de integración de atomicidad de la expiración, que hoy no existe: si `applyStatusUpdate` falla
  dentro de `expireOne`, la ubicación **no** queda anonimizada ni hay evento en el outbox. Cubre el
  riesgo 1.

Después, un PR por paso, cada uno con `npm run lint`, `npm test` y `npm run test:integration` en
verde:

| Paso | Qué se mueve | Tests que lo cubren |
|---|---|---|
| 1 | `emergency-row-mapper.js` y `emergency-sql.js` (puro) | `map-emergency.test.js`, `emergency.repository.test.js` |
| 2 | `emergency-outbox.js` | `outbox-contract.integration` (valida las filas reales del outbox), `incident.repository.test`, secciones de outbox y retención de los dos tests del repositorio |
| 3 | `zone-context-links.js` | `zone-context-link-event` (unit e integración), `contextos-zona-activos.integration`, `listeners/contexto-zona.integration` |
| 4 | `location-anonymizer.js` | `location-retention.test`, secciones de retención de los dos tests del repositorio |
| 5 | `emergency-lifecycle.js` | `emergency-lifecycle.integration`, `emergency-rules-v26.integration`, `operational-status.integration`, `assign`, `return-emergency`, integraciones de listeners que cancelan o cierran |
| 6 | `emergency-expiration.js` (depende de 4 y 5) | `emergency-expiration.integration`, `emergency-expiration-job.test`, el test nuevo del paso 0 |
| 7 | `emergency-creation.js` | `panic-button-idempotency` (unit e integración), `panic-button.test`, `consumer.integration` y el resto de las integraciones de listeners |
| 8 | `emergency-queries.js` | `emergency.test`, `authorization-matrix`, `findPage` de los dos tests del repositorio, `incident-detection-job` (unit e integración), `incident.repository.integration` |
| 9 | Etapa B (opcional): wiring por módulo en `index.js` | tests de jobs, rutas e `IncidentRepository` con el módulo nuevo; actualizar los docs que nombran métodos (02, 04, 05, 06, 09, `prioridad-eventos-publicos.md`, README) |

El orden va de lo que no tiene dependencias a lo que depende de todo: así cada paso mueve un
bloque cuyas dependencias ya están en su lugar.

## Riesgos

1. **Perder la transacción.** `create` y `updateStatus` corren en el `client` del `OutcomeFactory`, y
   `expireOne` encadena anonimización y cambio de estado en el suyo. Un módulo que use `this.pool`
   donde recibió un `client` escribe afuera de la transacción: el `ROLLBACK` deja de deshacerlo y la
   dedup del consumer ya no protege una reentrega. No rompe ningún test unitario. Lo frenan el test
   de atomicidad del paso 0 y los de integración de listeners que verifican "sin dejar nada escrito".
2. **Partir la sentencia de `linkZoneContexts`.** El vínculo y su evento del outbox se escriben en
   un solo `WITH ... INSERT` para que no exista uno sin el otro aunque el executor sea el pool. No
   se pasa por `emergency-outbox`: se mueve tal cual.
3. **Estado del proceso duplicado.** El `Set` de ids indescifrables ya avisados y
   `lastIdempotencyKeyPurgeAt` tienen que vivir en un solo lugar. `map-emergency.test.js` recarga el
   módulo con `jest.isolateModules` para vaciar el `Set`: hay que apuntarlo al módulo nuevo.
4. **`env` inyectado.** Los tests prenden `EVENTO_VINCULO_CONTEXTO_ENABLED` por `options.env`; si
   `zone-context-links.js` lee `process.env` directo, esos tests pasan por casualidad o fallan.
5. **Diffs grandes y conflictos.** Son ~1.500 líneas movidas: cualquier PR abierto que toque el
   repositorio choca, y la review cuesta aunque sea un movimiento. Por eso un PR por paso.
6. **No tocar el dominio de incidentes.** `linkZoneContexts` importa `haversineDistanceMeters` de
   `src/domain/rule-based-grouper.js`. El corte no cambia ese import.

## Por qué no antes del 26/11

- El Hito 2 es del 19 al 26/11. Este archivo es el núcleo del SOS (`create`, `updateStatus`,
  `assignOfficer`) y de los diez listeners: una regresión acá rompe la demo, y el refactor no
  agrega nada visible.
- El archivo se está tocando esta semana: el #134 (job de incidentes) lo cambió el 17/11, y el PR
  de los mensajes de error de la API puede tocar los `NotFoundError` y `ConflictError` que tira.
  Mover 1.500 líneas ahora deja en conflicto a todo lo que esté abierto.
- El riesgo 1 no lo ve ningún test unitario. Hace falta el paso 0 en `main` y review con tiempo, que
  esta semana no hay.

Lo que sí entra antes del 26/11 es este plan, para responder la corrección con un camino concreto.
Arranca después de la entrega, por el paso 0.
