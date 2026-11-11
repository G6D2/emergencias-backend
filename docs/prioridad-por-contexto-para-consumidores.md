# Guía para recalcular la prioridad elevada por eventos públicos (CityPass+)

Documento **autocontenido** para equipos que consumen `EmergenciaCreada` y `EmergenciaActualizada` del bus (Analítica, Reclamos, Movilidad, etc.). No hace falta clonar el repo de Emergencias para usarlo.

---

## 1. Qué hace Emergencias y qué no publica

Mientras dura un evento comunitario de Espacios Públicos, Emergencias atiende con **un nivel más de prioridad** las emergencias del barrio del evento. Es una regla interna de despacho:

- **No cambia lo que se publica.** `data.prioridad` de `EmergenciaCreada` y `EmergenciaActualizada` es siempre la prioridad original de la emergencia, haya o no un evento en curso.
- **No hay un evento por cada suba ni por cada baja.** La suba no se guarda: se calcula al leer y desaparece sola cuando el evento termina o se cancela.

Quien necesite saber con qué prioridad se atendió una emergencia puede recalcularlo con los eventos que ya están en el bus.

---

## 2. Datos necesarios

| Dato | Evento | Campos |
|------|--------|--------|
| Lugar y ventana del evento público | `com.citypass.espacios.EventoComunitarioPublicado` | `data.eventoId`, `data.latitud`, `data.longitud`, `data.inicio`, `data.fin`, `data.estado` |
| Cancelación del evento | `com.citypass.espacios.EventoCancelado` | `data.eventoId`, `data.canceladoEn` |
| Emergencia | `EmergenciaCreada` | `data.emergenciaId`, `data.barrio`, `data.categoria`, `data.prioridad`, `data.createdAt` |
| Cambios de estado | `EmergenciaActualizada` | `data.emergenciaId`, `data.estadoNuevo`, `data.updatedAt` |

---

## 3. La regla

Una emergencia está elevada en un instante `t` si se cumple todo esto:

1. **Mismo barrio.** `data.barrio` de la emergencia es el barrio del evento (ver sección 4).
2. **Dentro de la ventana.** `inicio <= t < fin` del evento.
3. **Evento no cancelado.** No llegó un `EventoCancelado` de ese `eventoId` antes de `t`, ni un `EventoComunitarioPublicado` con `estado = CANCELLED`. La cancelación es definitiva: una republicación posterior no reactiva la suba.
4. **Emergencia abierta.** En `t` no está en `CERRADA`, `CANCELADA` ni `DESCARTADA`.
5. **No es la cobertura del evento.** `categoria` distinta de `PREVENTIVA`.

Cuando se cumple, la prioridad de despacho es un nivel más que `data.prioridad`:

| `data.prioridad` | Con evento en curso en el barrio |
|---|---|
| `BAJA` | `MEDIA` |
| `MEDIA` | `ALTA` |
| `ALTA` | `CRITICA` |
| `CRITICA` | `CRITICA` (tope) |

Varios eventos a la vez en el mismo barrio suben **un solo nivel**, no uno por evento.

En la práctica, una emergencia estuvo elevada durante la intersección entre su vida abierta (de `createdAt` hasta el estado terminal) y la ventana del evento.

---

## 4. Barrio del evento

Emergencias deriva el barrio con las coordenadas del evento, por punto en polígono sobre el catálogo oficial de los 48 barrios de CABA ([datos abiertos GCBA](https://data.buenosaires.gob.ar/dataset/barrios)). Es el mismo catálogo y los mismos nombres (en mayúsculas, por ejemplo `PALERMO`) que viajan en `data.barrio` de las emergencias.

- Si el punto cae en un hueco entre polígonos, se toma el barrio más cercano a no más de 100 m.
- Sin coordenadas, se usa el texto `barrio` o `zona` del evento solo si coincide con un nombre del catálogo (sin distinguir mayúsculas ni tildes).
- Un evento fuera de CABA o sin barrio derivable **no eleva nada**.

Atajo para eventos grandes: si la capacidad del evento llega al umbral de cobertura preventiva (500), Emergencias publica una `EmergenciaCreada` con `categoria = PREVENTIVA`, `causaTipo = EVENTO_PUBLICO`, `causaId = <eventoId>` y `barrio` ya derivado. Ese es el barrio que usa la regla. La suba aplica igual a eventos chicos, que no generan esa emergencia.

---

## 5. Casos límite

| Caso | Qué hace Emergencias |
|---|---|
| El evento se republica (cambian inscriptos, fechas o lugar) | Vale la última versión: barrio y ventana se reemplazan |
| El evento no trae `fin` | La ventana dura 6 horas desde `inicio` |
| El evento no trae `inicio` | La ventana arranca cuando Emergencias recibe el evento |
| `fin` no es posterior a `inicio` | Se ignora `fin` y la ventana dura 6 horas |
| La cancelación llega antes que la publicación | El evento nunca eleva nada |

---

## 6. Límites de este recálculo

- Cubre solo la suba por eventos públicos. La prioridad con la que trabaja el dispatcher también puede subir cuando varias emergencias cercanas se agrupan en un incidente; ese cálculo es interno y no se puede reconstruir desde el bus.
- Los dos casos que dependen de cuándo recibió Emergencias el evento (sin `inicio`, o republicado sin fechas) no se pueden reproducir con exactitud desde afuera.
