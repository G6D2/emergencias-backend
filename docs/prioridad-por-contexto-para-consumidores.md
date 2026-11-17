# Guía de la prioridad elevada por contextos de zona (CityPass+)

Documento **autocontenido** para equipos que consumen eventos de Emergencias del bus (Analítica, Reclamos, Movilidad, etc.). No hace falta clonar el repo de Emergencias para usarlo.

---

## 1. Qué hace Emergencias y qué publica

Emergencias atiende con **un nivel más de prioridad** algunas emergencias mientras dura una situación de la ciudad. Hoy hay dos:

- **Un evento comunitario de Espacios Públicos:** sube las emergencias que se crean cerca del evento (a no más de 500 m). Ver sección 3.
- **Una alerta climática de Espacios Públicos:** sube las emergencias abiertas de los barrios de la alerta, solo para los tipos que afecta el fenómeno y solo si la gravedad es ALTA o EXTREMA. Ver sección 4.

Es una regla interna de despacho:

- **`data.prioridad` no cambia.** En `EmergenciaCreada` y `EmergenciaActualizada` es siempre la prioridad original de la emergencia, haya o no una situación en curso.
- **El vínculo sí se publica**, como evento propio: `EmergenciaVinculadaAContextoZona` (ver sección 1.1). Es la forma recomendada de saber qué emergencias se elevaron y por qué evento.
- **No hay un evento por cada suba ni por cada baja.** La suba se calcula al leer y desaparece sola cuando la situación termina o se cancela.

### 1.1 Recomendado: `EmergenciaVinculadaAContextoZona`

Sale uno por cada emergencia vinculada a un contexto (un evento de Espacios). Es el mismo dato que usa el tablero del dispatcher, encolado en la misma sentencia que lo guarda: no hace falta recalcular nada ni medir distancias.

| Campo | Para qué |
|---|---|
| `emergenciaId` | La emergencia (cruza con `EmergenciaCreada`) |
| `contextoId` | El contexto en Emergencias |
| `contextoTipo` | `EVENTO_ESPACIO_PUBLICO` o `ALERTA_CLIMATICA` |
| `contextoOrigen` | Módulo de origen (`espacios`) |
| `referenciaExterna` | El `eventoId` de Espacios. **Agrupar por este campo** para contar por evento |
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
| Alerta climática | `espaciospublicos.alerta-climatica.confirmada` (nombre por confirmar) | `data.alertaId`, `data.version`, `data.fenomeno`, `data.gravedad`, `data.barrios`, `data.fechaInicio`, `data.fechaFinEstimada` |
| Fin de la alerta | Finalización de la alerta (nombre y payload por confirmar) | `data.alertaId` |
| Emergencia | `EmergenciaCreada` | `data.emergenciaId`, `data.latitud`, `data.longitud`, `data.barrio`, `data.categoria`, `data.prioridad`, `data.createdAt` |
| Cambios de estado | `EmergenciaActualizada` | `data.emergenciaId`, `data.estadoNuevo`, `data.updatedAt` |

---

## 3. La regla del evento comunitario

La cercanía se decide **una sola vez, cuando se crea la emergencia**. Una emergencia queda vinculada a un evento si, en su `createdAt`:

1. **Está dentro del radio.** La distancia entre la emergencia y el punto del evento es de 500 m o menos (ver sección 5).
2. **El evento está en curso.** `inicio <= createdAt < fin`, y la última versión del evento publicada antes de `createdAt` no está suspendida ni cancelada.
3. **No es la cobertura del evento.** `categoria` distinta de `PREVENTIVA`.

Una emergencia que ya existía cuando el evento empieza **no se vincula**, aunque siga abierta durante todo el evento.

Una emergencia vinculada está elevada en un instante `t` mientras se cumple todo esto:

1. **Dentro de la ventana.** `inicio <= t < fin`, con las fechas de la última versión del evento.
2. **Evento no suspendido.** La última versión publicada del evento antes de `t` no tiene `estado = SUSPENDED`. Al reanudarse (una publicación posterior con otro estado) vuelve a elevar.
3. **Evento no cancelado.** No llegó un `EventoCancelado` de ese `eventoId` antes de `t`, ni un `EventoComunitarioPublicado` con `estado = CANCELLED`. La cancelación es definitiva: una republicación posterior no reactiva la suba.
4. **Emergencia abierta.** En `t` no está en `CERRADA`, `CANCELADA` ni `DESCARTADA`.

En la práctica, una emergencia creada cerca de un evento en curso estuvo elevada desde su `createdAt` hasta que cerró o hasta que terminó el evento, lo que haya pasado primero.

---

## 4. La regla de la alerta climática

A diferencia del evento, la alerta **no se mide al crear la emergencia**: alcanza a toda emergencia abierta de sus barrios mientras dura, aunque se haya creado antes de la alerta.

Una emergencia está elevada por una alerta en un instante `t` mientras se cumple todo esto:

1. **Está en un barrio de la alerta.** `data.barrio` de `EmergenciaCreada` está en `data.barrios` de la última versión de la alerta (comparando sin mayúsculas ni acentos). Una emergencia sin barrio (`null`) no se eleva.
2. **El fenómeno afecta su tipo.** `data.categoria` está en la tabla de abajo para el `fenomeno` de la última versión.
3. **La gravedad llega al umbral.** `gravedad` de la última versión es `ALTA` o `EXTREMA`. Con `LEVE`, `MEDIA` o una gravedad desconocida la alerta existe, pero no eleva nada.
4. **Dentro de la ventana.** `fechaInicio <= t < fin`, donde `fin` es lo primero que pase entre:
   - la llegada de la finalización de ese `alertaId`;
   - `fechaFinEstimada` + 3 horas, o `fechaInicio` + 24 horas si no viene `fechaFinEstimada`.
5. **Emergencia abierta.** En `t` no está en `CERRADA`, `CANCELADA` ni `DESCARTADA`.

"Última versión" es la de `version` más alta recibida antes de `t`. Una versión menor que llega tarde no cambia nada. La finalización es definitiva: una confirmación posterior del mismo `alertaId` no la reactiva.

| `fenomeno` | Categorías que eleva |
|---|---|
| `LLUVIA_FUERTE`, `GRANIZO` | `INFRAESTRUCTURA`, `TRANSITO` |
| `TORMENTA_ELECTRICA`, `VIENTO_FUERTE` | `INCENDIO`, `INFRAESTRUCTURA`, `TRANSITO` |
| `TORNADO` | `MEDICA`, `INCENDIO`, `INFRAESTRUCTURA`, `TRANSITO` |
| `INUNDACION` | `MEDICA`, `INFRAESTRUCTURA`, `TRANSITO` |
| `OLA_DE_CALOR` | `MEDICA`, `INCENDIO`, `INFRAESTRUCTURA` |
| `FRIO_EXTREMO` | `MEDICA` |
| `NIEBLA` | `TRANSITO` |
| Cualquier otro | `INFRAESTRUCTURA` |

Una alerta nunca eleva `DISTURBIO_EVENTO_MASIVO`, `OTRO`, `PANICO` ni `PREVENTIVA`.

Si cambia la tabla o el umbral (son configurables en Emergencias), se avisa.

---

## 5. Cuánto sube

Cuando una emergencia está alcanzada por un evento, por una alerta o por los dos, la prioridad de despacho es un nivel más que `data.prioridad`:

| `data.prioridad` | Alcanzada por un contexto en curso |
|---|---|
| `BAJA` | `MEDIA` |
| `MEDIA` | `ALTA` |
| `ALTA` | `CRITICA` |
| `CRITICA` | `CRITICA` (tope) |

Varios contextos a la vez que alcanzan a la misma emergencia suben **un solo nivel**, no uno por contexto, aunque uno sea un evento y otro una alerta.

---

## 6. Distancia al evento

- **Punto del evento:** `data.latitud` y `data.longitud` de `EventoComunitarioPublicado`, tal como llegan. Un evento sin coordenadas numéricas **no eleva nada**: el texto `barrio` o `zona` no se usa.
- **Radio:** 500 m para todos los eventos. Es un valor fijo de Emergencias (Espacios no informa un radio); si cambia, se avisa.
- **Punto de la emergencia:** `data.latitud` y `data.longitud` de `EmergenciaCreada`, que van redondeadas a 3 decimales (~100 m). Una emergencia sin ubicación (`null`) nunca se eleva por un evento.
- **Fórmula:** distancia de círculo máximo (haversine) con radio terrestre de 6.371.000 m.

Emergencias mide con la coordenada exacta, que no sale del módulo. El recálculo con la coordenada redondeada puede diferir para emergencias que están a unos 100 m del borde del radio.

Para los eventos el barrio no interviene: una emergencia del mismo barrio que el evento pero a más de 500 m no se eleva, y una de otro barrio a menos de 500 m sí.

---

## 7. Casos límite

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
| La alerta trae barrios que no son de CABA o están mal escritos | Se ignoran; si no queda ninguno, la alerta no eleva nada |
| Una nueva versión de la alerta baja la gravedad a `MEDIA` | Deja de elevar desde que llega |
| Una nueva versión de la alerta trae solo barrios desconocidos | Se ignora: sigue valiendo la versión anterior |
| La alerta no trae `fechaInicio` | La ventana arranca cuando Emergencias recibe la alerta |
| `fechaFinEstimada` no es posterior a `fechaInicio` | Se ignora y la alerta pesa 24 horas como máximo |
| La finalización llega antes que la confirmación | La alerta nunca eleva nada |

---

## 8. Límites de este recálculo

- Cubre solo la suba por contextos de zona. La prioridad con la que trabaja el dispatcher también puede subir cuando varias emergencias cercanas se agrupan en un incidente; ese cálculo es interno y no se puede reconstruir desde el bus.
- Los casos que dependen de cuándo recibió Emergencias un evento (primera publicación sin `inicio`, una alerta sin `fechaInicio`, la llegada de la finalización, o una emergencia creada justo antes de que llegue la publicación) no se pueden reproducir con exactitud desde afuera.
- Cerca del borde del radio el resultado puede diferir, porque afuera solo se conoce la coordenada redondeada.
