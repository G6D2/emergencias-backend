# Calibración de DBSCAN para agrupar emergencias

> **Datos sintéticos.** Todo lo que sigue sale de un dataset generado con semilla fija. No
> representa patrones reales de reportes de ninguna ciudad: sirve para comparar combinaciones de
> parámetros entre sí y entender cómo se comporta el algoritmo, no para estimar tasas reales.

El ADR [Usar DBSCAN para agrupar emergencias](https://github.com/G6D2/ADRs/blob/main/adr/usar-dbscan-para-agrupar-emergencias.md)
dejó los parámetros de `DbscanGrouper` sin calibrar: "se ajustarán en Sprint 3-4 mediante el
dataset sintético y quedarán configurables". Este documento es esa calibración.

**Resultado:** los defaults actuales (`eps` = 300 m, `minPts` = 2, ventana de 15 min) quedan bien y
no hace falta cambiarlos. Son la combinación que mejor aguanta el peor de los tres escenarios
probados. Si en la calle el GPS resulta mejor que lo supuesto, 250 m daría menos fusiones (ver
[Recomendación](#recomendación)).

Para reproducirlo:

```bash
node scripts/calibrar-dbscan.js              # ~20 s, imprime las tablas de este documento
node scripts/calibrar-dbscan.js --completo   # además, el barrido completo de cada escenario
node scripts/calibrar-dbscan.js --semilla 42 --replicas 20   # otra serie de datasets
```

El guion para mostrarlo en vivo está en [guion-demo-dbscan.md](guion-demo-dbscan.md).

## Qué se calibra

El job de detección (`src/services/incident-detection-job.js`) corre cada minuto. En cada pasada
trae las emergencias recientes, las separa por `emergencyType` y le pasa cada grupo a
`DbscanGrouper` (`src/domain/dbscan-grouper.js`). Los parámetros salen de variables de entorno:

| Variable | Default | Qué controla |
|---|---|---|
| `INCIDENT_RADIUS_M` | 300 | `eps` de DBSCAN, en metros (distancia Haversine). Dos reportes son vecinos si están a menos de `eps` |
| `INCIDENT_MIN_CITIZENS` | 2 | Dos cosas a la vez: el `minPts` de DBSCAN (cuenta **reportes**, incluido el propio) y el filtro posterior que descarta clusters con menos ciudadanos **distintos**. No se pueden configurar por separado |
| `INCIDENT_WINDOW_MIN` | 15 | Prefiltro: solo entran las emergencias creadas en los últimos N minutos que no estén cerradas, canceladas ni descartadas. No es una dimensión de DBSCAN |
| `INCIDENT_DETECTION_INTERVAL_MS` | 60000 | Cada cuánto corre el job. La primera pasada es 15 s después del arranque |

Tres detalles que cambian cómo leer los resultados:

- **El tipo también es un prefiltro.** Se agrupa solo dentro del mismo `emergencyType` (todos menos
  `PREVENTIVA`). Un SOS (`PANICO`) y un reporte de `DISTURBIO_EVENTO_MASIVO` en la misma esquina no
  se juntan nunca.
- **La ventana no limita la duración de un incidente.** Si un reporte nuevo cae cerca de un miembro
  de un incidente que todavía está dentro de la ventana, se suma a ese incidente. Lo que no se suma
  es un reporte cuyos vecinos ya salieron de la ventana.
- **La ventana tampoco recorta el score.** Decide quién entra a un incidente, pero el Risk Engine
  puntúa un incidente existente con todos sus miembros activos, también los que ya salieron de la
  ventana (ver [el hallazgo corregido](#hallazgo-corregido-el-score-de-un-incidente-bajaba-cuando-sus-primeros-reportes-salían-de-la-ventana)).
- **En producción rigen los defaults.** `render.yaml` no fija ninguna de estas variables, así que
  salvo que alguien las haya cargado a mano en el dashboard de Render, producción usa los valores de
  la tabla.

El **fallback** (`RuleBasedGrouper`) solo corre si DBSCAN lanza una excepción, nunca porque no
encuentre grupos. Usa el mismo radio y el mismo mínimo, y agrupa por componentes conexas con
distancia ≤ radio. En este barrido arma exactamente los mismos grupos que DBSCAN (ver
[Limitaciones](#limitaciones)), así que los resultados valen para las dos estrategias.

Los umbrales del Risk Engine (`src/domain/risk-engine.js`: pesos, `PROXIMITY_CLUSTER_METERS`,
`RECENCY_WINDOW_MINUTES`) quedan afuera: deciden el score de un incidente, no qué reportes lo forman.

## Método

### Dataset sintético

`scripts/calibrar-dbscan.js` genera cuatro horas de reportes sobre CABA con un generador
pseudoaleatorio de semilla fija (mulberry32), así que el mismo comando da los mismos números en
cualquier máquina. Cada reporte trae su verdad de campo (a qué hecho real pertenece, o si es un
reporte aislado), que el job nunca ve: solo se usa para medir.

| Supuesto | Valor |
|---|---|
| Hechos reales | 40 en 4 h (80 en carga alta). Cada uno de un solo tipo |
| Ciudadanos por hecho | 2 (35 %), 3 (30 %), 4 (15 %), 5 (10 %), 6 (5 %), 8 (5 %). Todos distintos |
| Dispersión de cada reporte respecto del hecho | Uniforme entre 20 y 150 m (GPS más posición del testigo); hasta 300 m en "GPS pobre" |
| Momento de los reportes | El primero en t0; los siguientes con demora exponencial de media 3 min (tope 12 min); un 10 % reporta tarde, entre 12 y 25 min después |
| Hechos vecinos (caso difícil) | Con probabilidad 20 %, otro hecho real del mismo tipo a 300–700 m y ±10 min |
| Reportes aislados (ruido) | 120 en 4 h (480 en carga alta), uno por ciudadano |
| Dónde | La mitad alrededor de seis zonas con mucho movimiento (Obelisco, Constitución, Once, Retiro, Palermo, Flores; desvío 700 m), la otra mitad uniforme dentro de CABA (GeoJSON de barrios del backend) |
| Tipos | PANICO 30 %, MEDICA 25 %, OTRO, INFRAESTRUCTURA y DISTURBIO 10 % c/u, INCENDIO 8 %, TRANSITO 7 % |

Con eso se arman tres escenarios:

| Escenario | Hechos | Reportes por réplica | Reportes aislados | Dispersión |
|---|---:|---:|---:|---|
| Normal | ~49 | ~287 | 120 | 20–150 m |
| Carga alta | ~97 | ~810 | 480 | 20–150 m |
| GPS pobre | ~49 | ~287 | 120 | 20–300 m |

Cada escenario se corre sobre 20 réplicas (semillas 1711 a 1730) y se promedia.

### Simulación

El script no copia el algoritmo. Corre el job real (`detectIncidents`, que llama a
`processEmergencyTypeCandidates` → `detectGroups` → `DbscanGrouper`) una vez por minuto sobre un
reloj simulado, contra repositorios en memoria que imitan lo que el job usa de los reales:
`findRecentByType` (ventana, tipo y miembros ya vinculados), `findActiveByIncidentIds` (todos los
miembros de cada incidente, para el score) y `create`/`addMember`/`applyScoringDecision`. Así, la
ventana, el prefiltro por tipo, el filtro de ciudadanos únicos y la
vinculación incremental a incidentes ya existentes funcionan como en el backend. En las
64 × 3 × 20 simulaciones, todos los incidentes quedaron con `algorithmVersion` = `dbscan-v1`: el
fallback no se activó nunca.

### Barrido

- `eps`: 50, 100, 150, 200, 250, 300, 500 y 800 m
- `minPts` (`INCIDENT_MIN_CITIZENS`): 2 y 3
- Ventana: 5, 10, 15 y 30 min

Son 64 combinaciones por escenario.

### Métricas

Se comparan los incidentes que armó el job con la verdad de campo. Un reporte sin incidente cuenta
como grupo de uno.

| Métrica | Qué mide |
|---|---|
| Precisión de pares | De los pares de reportes que el job puso en el mismo incidente, cuántos eran del mismo hecho |
| Recall de pares | De los pares de reportes del mismo hecho, cuántos terminaron en el mismo incidente |
| ARI (Adjusted Rand Index) | Acuerdo global entre el agrupamiento y la verdad: 1 es idéntico, ~0 es azar |
| Hechos detectados | Hechos con al menos 2 reportes en un mismo incidente |
| Hechos partidos | Hechos cuyos reportes quedaron en 2 o más incidentes distintos (por réplica) |
| Fusiones | Incidentes que mezclan reportes de 2 o más hechos reales (por réplica) |
| Incidentes falsos | Incidentes en los que ningún hecho real aporta 2 reportes: los armó el ruido (por réplica) |
| Ruido agrupado | Porcentaje de reportes aislados que terminaron dentro de algún incidente |

### Criterio de elección

No sabemos cuál de los tres escenarios se parece más a la calle, así que se elige la combinación
con **el mejor ARI en el peor escenario** (desempate: ARI promedio). Además se mira que no se pierdan
hechos: un incidente falso solo sube la prioridad de dos reportes (el invariante del Risk Engine
nunca la baja), mientras que un hecho no detectado se queda sin la escalada.

## Resultados

### Resumen entre escenarios

Las ocho mejores combinaciones según el criterio. Entre paréntesis, los hechos detectados.

| eps (m) | minPts | Ventana (min) | Normal | Carga alta | GPS pobre | ARI peor escenario |
|---:|---:|---:|---:|---:|---:|---:|
| **300 (actual)** | **2** | **15** | 0,92 (98 %) | 0,87 (97 %) | 0,84 (89 %) | **0,84** |
| 250 | 2 | 30 | 0,95 (100 %) | 0,86 (100 %) | 0,83 (85 %) | 0,83 |
| 300 | 2 | 30 | 0,93 (100 %) | 0,82 (100 %) | 0,86 (93 %) | 0,82 |
| 300 | 3 | 30 | 0,90 (71 %) | 0,81 (74 %) | 0,82 (65 %) | 0,81 |
| 300 | 2 | 10 | 0,89 (95 %) | 0,85 (95 %) | 0,80 (86 %) | 0,80 |
| 250 | 2 | 15 | 0,94 (98 %) | 0,90 (97 %) | 0,80 (82 %) | 0,80 |
| 250 | 3 | 30 | 0,92 (70 %) | 0,85 (72 %) | 0,79 (55 %) | 0,79 |
| 300 | 3 | 15 | 0,86 (65 %) | 0,83 (67 %) | 0,79 (59 %) | 0,79 |

Para ver si el orden depende de los datasets elegidos, se repitió con otras dos series de 20
réplicas (`--semilla 42` y `--semilla 9000`). En las dos, la combinación actual también sale
primera (0,84 y 0,85 en el peor escenario).

### `eps` (con `minPts` = 2 y ventana de 15 min)

**Normal**

| eps (m) | Precisión | Recall | ARI | Detectados | Partidos | Fusiones | Falsos | Ruido agrupado |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 0,99 | 0,12 | 0,21 | 34 % | 2,3 | 0,0 | 0,2 | 0 % |
| 100 | 0,99 | 0,51 | 0,67 | 70 % | 3,4 | 0,1 | 0,6 | 1 % |
| 150 | 0,98 | 0,82 | 0,89 | 88 % | 1,1 | 0,3 | 0,8 | 1 % |
| 200 | 0,97 | 0,93 | 0,94 | 95 % | 0,5 | 0,8 | 0,9 | 2 % |
| 250 | 0,94 | 0,94 | 0,94 | 98 % | 0,3 | 1,2 | 1,0 | 2 % |
| **300 (actual)** | 0,90 | 0,94 | 0,92 | 98 % | 0,6 | 1,8 | 1,4 | 3 % |
| 500 | 0,74 | 0,95 | 0,83 | 98 % | 0,5 | 6,5 | 2,6 | 6 % |
| 800 | 0,64 | 0,95 | 0,76 | 98 % | 0,6 | 9,0 | 4,3 | 11 % |

**Carga alta**

| eps (m) | Precisión | Recall | ARI | Detectados | Partidos | Fusiones | Falsos | Ruido agrupado |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 0,97 | 0,13 | 0,23 | 36 % | 4,9 | 0,1 | 1,8 | 1 % |
| 100 | 0,97 | 0,53 | 0,69 | 70 % | 6,6 | 0,3 | 3,4 | 2 % |
| 150 | 0,94 | 0,84 | 0,89 | 86 % | 2,2 | 0,7 | 6,5 | 3 % |
| 200 | 0,91 | 0,93 | 0,92 | 94 % | 1,1 | 1,6 | 9,3 | 5 % |
| 250 | 0,86 | 0,94 | 0,90 | 97 % | 1,3 | 3,0 | 12,1 | 7 % |
| **300 (actual)** | 0,80 | 0,94 | 0,87 | 97 % | 1,6 | 4,7 | 15,2 | 9 % |
| 500 | 0,60 | 0,95 | 0,73 | 98 % | 1,7 | 13,8 | 26,6 | 17 % |
| 800 | 0,45 | 0,96 | 0,61 | 98 % | 1,9 | 19,1 | 39,9 | 28 % |

**GPS pobre**

| eps (m) | Precisión | Recall | ARI | Detectados | Partidos | Fusiones | Falsos | Ruido agrupado |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 0,93 | 0,03 | 0,06 | 14 % | 0,3 | 0,3 | 0,4 | 0 % |
| 100 | 0,95 | 0,15 | 0,25 | 38 % | 2,5 | 0,7 | 0,9 | 1 % |
| 150 | 0,94 | 0,33 | 0,48 | 58 % | 3,9 | 1,4 | 1,2 | 1 % |
| 200 | 0,91 | 0,54 | 0,68 | 72 % | 4,0 | 1,9 | 1,6 | 2 % |
| 250 | 0,88 | 0,75 | 0,80 | 82 % | 2,3 | 2,7 | 1,4 | 3 % |
| **300 (actual)** | 0,83 | 0,85 | 0,84 | 89 % | 1,4 | 3,7 | 1,4 | 3 % |
| 500 | 0,72 | 0,94 | 0,81 | 98 % | 0,6 | 7,3 | 2,6 | 6 % |
| 800 | 0,64 | 0,95 | 0,76 | 98 % | 0,6 | 8,9 | 4,3 | 11 % |

### `minPts` (con `eps` = 300 m y ventana de 15 min)

| Escenario | minPts | Precisión | Recall | ARI | Detectados | Falsos |
|---|---:|---:|---:|---:|---:|---:|
| Normal | **2** | 0,90 | 0,94 | 0,92 | 98 % | 1,4 |
| Normal | 3 | 0,89 | 0,85 | 0,86 | 65 % | 0,1 |
| Carga alta | **2** | 0,80 | 0,94 | 0,87 | 97 % | 15,2 |
| Carga alta | 3 | 0,81 | 0,86 | 0,83 | 67 % | 1,6 |
| GPS pobre | **2** | 0,83 | 0,85 | 0,84 | 89 % | 1,4 |
| GPS pobre | 3 | 0,81 | 0,78 | 0,79 | 59 % | 0,1 |

### Ventana (con `eps` = 300 m y `minPts` = 2)

Cada celda: ARI · hechos partidos · incidentes falsos.

| Ventana (min) | Normal | Carga alta | GPS pobre |
|---:|---:|---:|---:|
| 5 | 0,81 · 2,0 · 0,3 | 0,81 · 4,0 · 6,4 | 0,73 · 2,0 · 0,7 |
| 10 | 0,89 · 1,2 · 0,8 | 0,85 · 3,0 · 11,3 | 0,80 · 1,9 · 1,0 |
| **15 (actual)** | 0,92 · 0,6 · 1,4 | 0,87 · 1,6 · 15,2 | 0,84 · 1,4 · 1,4 |
| 30 | 0,93 · 0,3 · 2,1 | 0,82 · 0,7 · 22,6 | 0,86 · 1,4 · 2,4 |

## Qué dicen los resultados

- **Con `eps` chico se parten los hechos.** Si cada testigo puede estar a 150 m del hecho, dos
  testigos pueden quedar a 300 m entre sí. Con 100 m se detecta el 70 % de los hechos y con 50 m, un
  tercio. DBSCAN los recupera en parte por cadena (A cerca de B, B cerca de C), pero no alcanza.
- **Con `eps` grande se mezclan hechos y se suma ruido.** Desde 500 m, la precisión cae a 0,74 o
  menos y aparecen entre 6 y 19 fusiones por réplica; en carga alta, además, entre 27 y 40
  incidentes falsos cada 4 h.
- **La zona buena está entre 200 y 300 m, y dentro de ella el óptimo depende del GPS.** Con
  dispersión de hasta 150 m, 200–250 m da mejor precisión que 300 m (fusiones: de 1,8 a 0,8–1,2 en
  normal y de 4,7 a 1,6–3,0 en carga alta); 250 m detecta los mismos hechos y 200 m, 3 puntos
  menos. Pero si el GPS es peor, 200 m deja
  sin detectar el 28 % de los hechos y 250 m el 18 %, contra el 11 % con 300 m.
- **`minPts` = 3 casi elimina los incidentes falsos, pero ignora los hechos de dos testigos.** Con el
  supuesto de que un 35 % de los hechos tiene dos reportantes, la detección cae a dos tercios. Como
  el mismo número también fija los ciudadanos únicos mínimos, subirlo es pedir tres personas
  distintas para cualquier incidente.
- **La ventana de 15 min queda en el medio en los tres escenarios.** Con 5 o 10 min se parten los
  hechos que tienen un reporte tardío. Con 30 min se recuperan algunos, pero en carga alta los
  incidentes falsos pasan de 15 a 23 cada 4 h.

## Recomendación

**Mantener los defaults: `INCIDENT_RADIUS_M=300`, `INCIDENT_MIN_CITIZENS=2`, `INCIDENT_WINDOW_MIN=15`.**
Son la combinación que mejor aguanta el peor escenario, detectan el 97–98 % de los hechos con GPS
razonable y el 89 % con GPS pobre. El costo es aceptar más fusiones que con 250 m; en una fusión,
el despachador igual ve la ubicación de cada reporte en su detalle.

Revisarlo cuando haya incidentes reales. Para eso no hace falta tocar código: cada decisión ya
guarda `factors.maxDistanceMeters` en `incidents.factors`. Si la gran mayoría de los incidentes
confirmados por despachadores tiene reportes a menos de ~200 m entre sí, conviene bajar
`INCIDENT_RADIUS_M` a 250 en Render: en el escenario de GPS razonable baja las fusiones sin perder
hechos. `minPts` = 3 no se recomienda mientras haya hechos con solo dos testigos.

## Hallazgo (corregido): el score de un incidente bajaba cuando sus primeros reportes salían de la ventana

> **Corregido en [#134](https://github.com/G6D2/emergencias-backend/pull/134).** Lo que sigue
> describe el problema y cómo quedó.

El job volvía a puntuar cada incidente en cada pasada, pero solo con los miembros que seguían
dentro de la ventana (`processEmergencyTypeCandidates` armaba los factores con el grupo que DBSCAN
encontraba entre los candidatos de `findRecentByType`). Cuando el primer reporte cumplía 15
minutos, el incidente se recalculaba con menos reportes y su prioridad podía bajar. No era un
problema de los parámetros sino del job.

Ejemplo con el job real, una pasada en cada minuto de la tabla: tres reportes de
`DISTURBIO_EVENTO_MASIVO` (severidad media) en un minuto, a menos de 71 m entre sí (el caso del
[guion de demo](guion-demo-dbscan.md)).

| Minutos desde el primer reporte | Reportes en la ventana | Antes: score · prioridad | Ahora: score · prioridad |
|---:|---:|---|---|
| 1,5 | 3 | 69 · Alta | 69 · Alta |
| 14,5 | 3 | 56 · Alta | 56 · Alta |
| 15,5 | 2 | 42 · Media | 55 · Alta |
| 16 o más | 1 | 42 · Media | 55 · Alta |

Antes, como `effectivePriority` es el máximo entre la severidad y la prioridad del incidente, los
tres reportes volvían a Media aunque el incidente siguiera teniendo tres miembros (el tablero
seguía mostrando "Incidente · 3 reportes"), y como cambiaba la prioridad, se publicaba
`EmergenciaPriorizada` con la baja.

Había dos opciones: puntuar con todos los miembros del incidente, o no bajar nunca la prioridad de
un incidente ya escalado mientras tuviera miembros activos. Se eligió la primera porque es lo que
dicen los ADR: el Risk Engine calcula la prioridad "a partir del `Incident` ya agrupado"
([Detectar incidentes y priorizar con motor determinístico](https://github.com/G6D2/ADRs/blob/main/adr/detectar-incidentes-y-priorizar-con-motor-deterministico.md))
y la ventana es un prefiltro de candidatos para el agrupamiento
([Usar DBSCAN para agrupar emergencias](https://github.com/G6D2/ADRs/blob/main/adr/usar-dbscan-para-agrupar-emergencias.md)).
La segunda dejaba el score y la prioridad guardados desalineados, y también frenaba bajas que sí
corresponden, como la de un reporte cancelado.

Cómo funciona ahora:

- **La ventana sigue decidiendo la membresía.** DBSCAN corre solo sobre los candidatos de los
  últimos 15 minutos: con ellos se forman grupos nuevos y se suman miembros a un incidente. Un
  reporte que ya salió de la ventana no atrae reportes nuevos.
- **El score de un incidente existente usa todos sus miembros activos.** Si algún candidato ya
  pertenece a un incidente, el job trae en una segunda query (`findActiveByIncidentIds`) los
  miembros no terminales de ese incidente, aunque hayan salido de la ventana, y el Risk Engine
  puntúa con todos. Esos miembros también reciben la `EmergenciaPriorizada` cuando la prioridad
  cambia (antes solo la recibían los de la ventana).
- **Un miembro que pasa a un estado terminal deja de contar**, como antes: si los demás siguen
  formando grupo en la ventana, el score se recalcula sin él y puede bajar, con su
  `EmergenciaPriorizada`.
- **Cuando ya no queda ningún par en la ventana, el job no vuelve a puntuar el incidente**: score y
  prioridad quedan como estaban (antes también). Por eso, en la tabla, desde el minuto 16 queda en 55.
- **La recencia sigue restando** alrededor de 1 punto por minuto mientras el grupo está en la
  ventana (es uno de los factores del Risk Engine, no tiene que ver con la ventana). Con dos
  reportes a 44 m, el score arranca en 62 y baja a 49 cerca del minuto 13,5: el incidente vuelve a
  Media y se publica `EmergenciaPriorizada`, antes y después de esta corrección. Con tres reportes,
  como en la demo, no llega a bajar de Alta.

La corrección no cambia ningún número de la calibración: los grupos son los mismos y
`scripts/calibrar-dbscan.js` da la misma salida que antes.

## Limitaciones

- **Los datos son sintéticos.** Cantidad de hechos, testigos por hecho, dispersión, demoras, tipos y
  zonas son supuestos razonables, no mediciones. Los números sirven para comparar combinaciones, no
  como tasas esperables en producción.
- **La dispersión es uniforme e independiente.** En la realidad los errores de GPS se correlacionan
  (varios teléfonos en el mismo edificio reciben la misma ubicación por wifi) y dependen del lugar.
  El escenario "GPS pobre" da una idea del costo si la dispersión es el doble, pero no la mide.
- **Un hecho es de un solo tipo.** En la calle, dos testigos del mismo hecho pueden elegir tipos
  distintos (uno aprieta SOS y otro reporta un disturbio), y esos reportes no se agrupan. Ese caso
  no está medido.
- **Nada cambia de estado en la simulación.** En producción, cerrar, cancelar o descartar una
  emergencia la saca de los candidatos.
- **No hay reportes repetidos del mismo ciudadano.** El filtro anti-spam (mínimo de ciudadanos
  distintos) lo cubren los tests de `dbscan-grouper` y `scripts/demo-dbscan.js`.
- **Con estos parámetros, DBSCAN y el fallback arman los mismos grupos.** Con `minPts` = 2, DBSCAN
  equivale a unir por cadena todos los reportes a menos de `eps` (single-linkage cortado en `eps`),
  que es lo que hace `RuleBasedGrouper` con ≤ radio. El script lo verifica: con `eps` = 300 m y
  ventana de 15 min, 0 diferencias en 4073 ventanas (por minuto y por tipo), con `minPts` = 2 y
  también con 3. La parte "de densidad" de DBSCAN recién se diferenciaría con `minPts` ≥ 4, que en
  este dominio dejaría afuera a la mayoría de los hechos. Es una consecuencia del dominio (pocos
  testigos por hecho), no un error de implementación, pero conviene tenerlo claro si preguntan qué
  aporta DBSCAN frente a la regla.
- **No se midió la latencia.** El tiempo hasta que aparece un incidente depende del intervalo del
  job (60 s), no de `eps` ni de `minPts`.

## Fuente en el código

- `scripts/calibrar-dbscan.js`: dataset, simulación, métricas y barrido
- `src/tests/calibrar-dbscan.test.js`: el dataset es estable con la semilla fija, las métricas dan
  lo esperado en casos armados a mano y DBSCAN coincide con el fallback
- `src/services/incident-detection-job.js` (variables y defaults), `src/domain/dbscan-grouper.js`,
  `src/domain/rule-based-grouper.js`, `src/domain/incident-detector.js`,
  `src/domain/incident-detection-strategy.js`, `src/domain/risk-engine.js`
- `src/repositories/emergency.repository.js` (`findRecentByType`, `findActiveByIncidentIds`)
- `src/tests/incident-detection-job.test.js` y `src/tests/incident-detection-job.integration.test.js`:
  el caso del hallazgo, con el reloj más allá de la ventana
