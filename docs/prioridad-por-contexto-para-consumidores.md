# Guía de la prioridad elevada por contextos de zona (CityPass+)

Documento **autocontenido** para equipos que consumen eventos de Emergencias del bus (Analítica, Reclamos, Movilidad, etc.). No hace falta clonar el repo de Emergencias para usarlo.

---

## 1. Qué hace Emergencias y qué publica

Emergencias atiende con **un nivel más de prioridad** las emergencias que se crean cerca de una situación de la ciudad mientras dura. Hoy hay dos, las dos de Espacios Públicos:

- **Un evento comunitario:** sube las emergencias que se crean a no más de 500 m del evento.
- **Una alerta climática `ALTA` o `CRITICA`:** sube las emergencias que se crean cerca de alguno de los puntos de la alerta (500 m con `ALTA`, 1000 m con `CRITICA`). Con `MEDIA` o `BAJA` no sube nada. Ver sección 3.1.

Las dos funcionan igual: un punto, un radio y una ventana. Es una regla interna de despacho:

- **`data.prioridad` no cambia.** En `EmergenciaCreada` y `EmergenciaActualizada` es siempre la prioridad original de la emergencia, haya o no un evento o una alerta en curso.
- **El vínculo sí se publica**, como evento propio: `EmergenciaVinculadaAContextoZona` (ver sección 1.1). Es la forma recomendada de saber qué emergencias se elevaron y por qué evento.
- **No hay un evento por cada suba ni por cada baja.** La suba se calcula al leer y desaparece sola cuando el evento termina o se cancela, o cuando la alerta vence o se finaliza.
- **La alerta climática no tiene evento propio de Emergencias.** La alerta ya la publica Espacios para todos. Lo único que suma Emergencias es una emergencia `PREVENTIVA` por alerta (`causaTipo = EVENTO_CLIMATICO`, `causaId = alertaId`), que sale en `EmergenciaCreada`.

### 1.1 Recomendado: `EmergenciaVinculadaAContextoZona`

Sale uno por cada emergencia vinculada a un contexto (un evento de Espacios o un punto de una alerta climática). Es el mismo dato que usa el tablero del dispatcher, encolado en la misma sentencia que lo guarda: no hace falta recalcular nada ni medir distancias.

| Campo | Para qué |
|---|---|
| `emergenciaId` | La emergencia (cruza con `EmergenciaCreada`) |
| `contextoId` | El contexto en Emergencias |
| `contextoTipo` | `EVENTO_ESPACIO_PUBLICO` o `ALERTA_CLIMATICA` |
| `contextoOrigen` | Módulo de origen (`espacios`) |
| `referenciaExterna` | El `eventoId` de Espacios, o `<alertaId>#<índice del punto>` en una alerta climática. **Agrupar por este campo** para contar por evento; para contar por alerta, agrupar por lo que está antes del último `#` |
| `radioMetros` | Radio con el que se decidió |
| `vinculadaEn` | Cuándo se vinculó (al crearse la emergencia) |
| `reglaVersion` | Versión de la regla. Si sube, cambió la forma de decidir el vínculo |
| `backfill` | `true` si salió de la carga inicial y no del alta |

Reglas para no contar mal:

- **Deduplicar por `(emergenciaId, contextoId)`.** El bus es *at-least-once*: el mismo vínculo puede llegar dos veces.
- **Significado:** la emergencia quedó vinculada al evento al crearse y, mientras los dos estuvieron vigentes, su prioridad de despacho estuvo un nivel arriba. Una emergencia vinculada estuvo elevada.
- **Se publican los vínculos de todas las categorías, `PANICO` incluida.** El ADR de coordenadas se aceptó con 3 decimales (~100 m) para todas, así que el vínculo no da más precisión que la coordenada.
- **Historia:** el evento existe desde su activación. Al activarlo se cargaron (`backfill: true`) los vínculos que seguían en la base: emergencias abiertas o cerradas hace menos de 72 h. Lo anterior no se puede recuperar.
- **Sin coordenadas.** El evento no lleva ubicación; si hace falta, sale de `EmergenciaCreada`.

Schema: [`docs/contratos/emergencia-vinculada-a-contexto-zona.schema.json`](contratos/emergencia-vinculada-a-contexto-zona.schema.json).

### 1.2 Alternativa: recalcular

El resto de esta guía explica cómo **recalcular** el vínculo y la suba con los eventos que ya están en el bus. Sirve para quien no pueda consumir `EmergenciaVinculadaAContextoZona` o necesite el estado de la suba en un instante dado. Tiene los límites de la sección 6: puede diferir de lo que hizo Emergencias.

---

## 2. Datos necesarios

| Dato | Evento | Campos |
|------|--------|--------|
| Lugar y ventana del evento público | `com.citypass.espacios.EventoComunitarioPublicado` | `data.eventoId`, `data.latitud`, `data.longitud`, `data.inicio`, `data.fin`, `data.estado` (también llegan así la suspensión y la reanudación) |
| Cancelación del evento | `com.citypass.espacios.EventoCancelado` | `data.eventoId`, `data.canceladoEn` |
| Alerta climática | `com.citypass.espacios.CriticidadClimaticaConfirmada` | `data.alertaId`, `data.nivelCriticidad`, `data.ubicaciones` (`[{ latitud, longitud }]`), `data.vigenciaDesde`, `data.vigenciaHasta` (epoch ms) |
| Fin de la alerta | `com.citypass.espacios.CriticidadClimaticaFinalizada` | `data.alertaId` |
| Emergencia | `EmergenciaCreada` | `data.emergenciaId`, `data.latitud`, `data.longitud`, `data.categoria`, `data.prioridad`, `data.createdAt` |
| Cambios de estado | `EmergenciaActualizada` | `data.emergenciaId`, `data.estadoNuevo`, `data.updatedAt` |

---

## 3. La regla

La cercanía se decide **una sola vez, cuando se crea la emergencia**. Una emergencia queda vinculada a un evento si, en su `createdAt`:

1. **Está dentro del radio.** La distancia entre la emergencia y el punto del evento es de 500 m o menos (ver sección 4).
2. **El evento está en curso.** `inicio <= createdAt < fin`, y la última versión del evento publicada antes de `createdAt` no está suspendida ni cancelada.
3. **No es la cobertura del evento.** `categoria` distinta de `PREVENTIVA`.

Una emergencia que ya existía cuando el evento empieza **no se vincula**, aunque siga abierta durante todo el evento.

Una emergencia vinculada está elevada en un instante `t` mientras se cumple todo esto:

1. **Dentro de la ventana.** `inicio <= t < fin`, con las fechas de la última versión del evento.
2. **Evento no suspendido.** La última versión publicada del evento antes de `t` no tiene `estado = SUSPENDED`. Al reanudarse (una publicación posterior con otro estado) vuelve a elevar.
3. **Evento no cancelado.** No llegó un `EventoCancelado` de ese `eventoId` antes de `t`, ni un `EventoComunitarioPublicado` con `estado = CANCELLED`. La cancelación es definitiva: una republicación posterior no reactiva la suba.
4. **Emergencia abierta.** En `t` no está en `CERRADA`, `CANCELADA` ni `DESCARTADA`.

Cuando se cumple, la prioridad de despacho es un nivel más que `data.prioridad`:

| `data.prioridad` | Vinculada a un evento en curso |
|---|---|
| `BAJA` | `MEDIA` |
| `MEDIA` | `ALTA` |
| `ALTA` | `CRITICA` |
| `CRITICA` | `CRITICA` (tope) |

Varios eventos a la vez que alcanzan a la misma emergencia suben **un solo nivel**, no uno por evento.

En la práctica, una emergencia creada cerca de un evento en curso estuvo elevada desde su `createdAt` hasta que cerró o hasta que terminó el evento, lo que haya pasado primero.

### 3.1 La alerta climática

Cada punto de `ubicaciones` de una alerta `ALTA` o `CRITICA` funciona como un evento: misma regla de vínculo al crear, misma suba de un nivel y sin acumular con otros eventos o alertas. Cambia esto:

- **Radio por nivel:** 500 m con `ALTA` y 1000 m con `CRITICA`. `MEDIA` y `BAJA` no suben nada.
- **Ventana:** `vigenciaDesde`–`vigenciaHasta` de la confirmación. No hay suspensión.
- **Fin:** `CriticidadClimaticaFinalizada` con el mismo `alertaId` termina la suba de todos los puntos, como una cancelación. Es definitiva.
- **Zona:** solo los puntos. `barrios` no define zona: una emergencia del mismo barrio pero lejos de los puntos no sube.
- **La `PREVENTIVA` de la alerta no sube** (es la cobertura de la propia alerta).

---

## 4. Distancia al evento

- **Punto del evento:** `data.latitud` y `data.longitud` de `EventoComunitarioPublicado`, tal como llegan. Un evento sin coordenadas numéricas **no eleva nada**: el texto `barrio` o `zona` no se usa.
- **Radio:** 500 m para todos los eventos. Para las alertas climáticas, 500 m con `ALTA` y 1000 m con `CRITICA`. Son valores de Emergencias (Espacios no informa un radio); si cambian, se avisa. `radioMetros` de `EmergenciaVinculadaAContextoZona` dice con qué radio se decidió.
- **Punto de una alerta:** cada elemento de `data.ubicaciones`, tal como llega. Un punto sin coordenadas numéricas se descarta.
- **Punto de la emergencia:** `data.latitud` y `data.longitud` de `EmergenciaCreada`, que van redondeadas a 3 decimales (~100 m). Una emergencia sin ubicación (`null`) nunca se eleva.
- **Fórmula:** distancia de círculo máximo (haversine) con radio terrestre de 6.371.000 m.

Emergencias mide con la coordenada exacta, que no sale del módulo. El recálculo con la coordenada redondeada puede diferir para emergencias que están a unos 100 m del borde del radio.

El barrio ya no interviene: una emergencia del mismo barrio que el evento pero a más de 500 m no se eleva, y una de otro barrio a menos de 500 m sí.

---

## 5. Casos límite

| Caso | Qué hace Emergencias |
|---|---|
| El evento se republica con otras fechas | Vale la última versión: las emergencias ya vinculadas se elevan en la ventana nueva |
| El evento se republica en otro lugar | Las emergencias ya vinculadas siguen vinculadas; las nuevas se miden contra el lugar nuevo |
| La emergencia se crea antes de que Emergencias reciba la publicación del evento | No se vincula, aunque el evento ya hubiera empezado |
| El evento se republica sin `inicio` ni `fin` | Se conserva la ventana anterior |
| El evento se suspende y después se reanuda con otra fecha | No eleva mientras está suspendido; al reanudarse eleva en la ventana nueva |
| El evento no trae `fin` | La ventana dura 6 horas desde `inicio` |
| El evento no trae `inicio` | La ventana arranca cuando Emergencias recibe el evento |
| `fin` no es posterior a `inicio` | Se ignora `fin` y la ventana dura 6 horas |
| La cancelación llega antes que la publicación | El evento nunca eleva nada |
| La finalización de una alerta llega antes que la confirmación | La alerta nunca eleva nada |
| La alerta llega con nivel `MEDIA` o `BAJA` | No eleva nada |
| La confirmación llega cuando la alerta ya venció | No eleva nada (la ventana ya pasó) |

---

## 6. Límites de este recálculo

- Cubre solo la suba por eventos públicos y alertas climáticas. La prioridad con la que trabaja el dispatcher también puede subir cuando varias emergencias cercanas se agrupan en un incidente; ese cálculo es interno y no se puede reconstruir desde el bus.
- Los casos que dependen de cuándo recibió Emergencias el evento (primera publicación sin `inicio`, o una emergencia creada justo antes de que llegue la publicación) no se pueden reproducir con exactitud desde afuera.
- Cerca del borde del radio el resultado puede diferir, porque afuera solo se conoce la coordenada redondeada.
