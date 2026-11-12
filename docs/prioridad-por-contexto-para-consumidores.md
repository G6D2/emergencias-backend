# Guía para recalcular la prioridad elevada por eventos públicos (CityPass+)

Documento **autocontenido** para equipos que consumen `EmergenciaCreada` y `EmergenciaActualizada` del bus (Analítica, Reclamos, Movilidad, etc.). No hace falta clonar el repo de Emergencias para usarlo.

---

## 1. Qué hace Emergencias y qué no publica

Mientras dura un evento comunitario de Espacios Públicos, Emergencias atiende con **un nivel más de prioridad** las emergencias que se crean cerca del evento (a no más de 500 m). Es una regla interna de despacho:

- **No cambia lo que se publica.** `data.prioridad` de `EmergenciaCreada` y `EmergenciaActualizada` es siempre la prioridad original de la emergencia, haya o no un evento en curso.
- **No hay un evento por cada suba ni por cada baja.** La suba no se guarda: se calcula al leer y desaparece sola cuando el evento termina o se cancela.

Quien necesite saber con qué prioridad se atendió una emergencia puede recalcularlo con los eventos que ya están en el bus.

---

## 2. Datos necesarios

| Dato | Evento | Campos |
|------|--------|--------|
| Lugar y ventana del evento público | `com.citypass.espacios.EventoComunitarioPublicado` | `data.eventoId`, `data.latitud`, `data.longitud`, `data.inicio`, `data.fin`, `data.estado` (también llegan así la suspensión y la reanudación) |
| Cancelación del evento | `com.citypass.espacios.EventoCancelado` | `data.eventoId`, `data.canceladoEn` |
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

---

## 4. Distancia al evento

- **Punto del evento:** `data.latitud` y `data.longitud` de `EventoComunitarioPublicado`, tal como llegan. Un evento sin coordenadas numéricas **no eleva nada**: el texto `barrio` o `zona` no se usa.
- **Radio:** 500 m para todos los eventos. Es un valor fijo de Emergencias (Espacios no informa un radio); si cambia, se avisa.
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

---

## 6. Límites de este recálculo

- Cubre solo la suba por eventos públicos. La prioridad con la que trabaja el dispatcher también puede subir cuando varias emergencias cercanas se agrupan en un incidente; ese cálculo es interno y no se puede reconstruir desde el bus.
- Los casos que dependen de cuándo recibió Emergencias el evento (primera publicación sin `inicio`, o una emergencia creada justo antes de que llegue la publicación) no se pueden reproducir con exactitud desde afuera.
- Cerca del borde del radio el resultado puede diferir, porque afuera solo se conoce la coordenada redondeada.
