# listeners

Listeners de eventos externos (Kafka). Se arrancan desde `src/index.js` con
`KAFKA_CONSUMER_ENABLED=true`.

```
listeners/
  event-listener.js            # clase abstracta: consumer, suscripcion, template method
  business-rule.js             # regla de negocio abstracta
  load-rules.js                # carga automatica de *.rule.js
  outcome-factory.js           # ejecuta los resultados en una transaccion con dedup
  event-decoder.js             # Avro (formato Confluent) o JSON -> { metadata, data }
  error-classifier.js          # errores transitorios vs permanentes
  index.js                     # createListeners(kafka, { factory, decoder }) + PACKAGES
  <caso-de-negocio>/           # un subpaquete por caso de negocio
    index.js                   # exporta `listeners: [ ... ]`
    <evento>/                  # una carpeta por listener
      <evento>.listener.js     # subclase de EventListener
      rules/                   # reglas de este listener, se cargan solas
        <regla>.rule.js        # una regla por archivo
    handlers/                  # handlers del OutcomeFactory de este caso
```

## Flujo de un evento

1. `onMessage` decodifica el mensaje con `event-decoder.js`: el gateway del
   Grupo 1 escribe Avro en formato Confluent (`[0x00][schemaId][avro]`) y el
   schema se resuelve contra `EDA_SCHEMA_REGISTRY_URL`. Lo que no empieza con
   `0x00` se lee como JSON (tests y Kafka local).
2. `handle(event)` es un template method (no se sobreescribe):
   1. `buildContext(event)` arma el contexto `{ metadata, data }`. Se puede
      sobreescribir para normalizar el evento.
   2. Para cada regla de la carpeta `rules/` del listener: si
      `appliesTo(context)` da true, se agrega el resultado de `apply(context)`.
      Aplican todas las que matchean, no solo la primera.
   3. Devuelve los resultados `{ type, payload }`. Las reglas no tienen side
      effects.
3. El `OutcomeFactory` ejecuta los resultados: busca el handler registrado
   para cada `type` (un `type` sin handler falla antes de abrir la
   transaccion), abre una sola transaccion, marca el `metadata.eventId` en
   `eventos_procesados` (si ya estaba, ROLLBACK y no hace nada) y corre los
   handlers con el mismo `client`. Los handlers escriben por los repositorios
   (outbox e historial incluidos), nunca con SQL directo sobre `emergencies`.
   Los handlers se registran en `src/index.js`.

## Errores

`error-classifier.js` decide:

- **Transitorio** (base caida, timeout, registry inalcanzable): el error se
  propaga a kafkajs, que no confirma el offset y reentrega el mensaje.
- **Permanente** (mensaje ilegible, payload invalido, `type` sin handler,
  constraint): se loguea, queda en `eventos_procesados` como `DISCARDED` con
  el motivo y el offset avanza. Un evento roto nunca frena el topico.

## Conexion al bus

- `group.id`: `com.citypass.emergencias.<Listener>` por default
  (`KAFKA_CONSUMER_GROUP_PREFIX` lo cambia, pero tiene que empezar con
  `com.citypass.emergencias.`: el broker solo acepta ese prefijo).
- SASL/OAUTHBEARER con el token client-credentials del Login Federado
  (`EDA_OAUTH_*`, ver `KafkaService`). Sin secreto se conecta sin SASL.
- `KAFKA_SSL=true` en produccion (SASL_SSL).

## Agregar una regla

Crear `<evento>/rules/<regla>.rule.js` exportando una subclase de
`BusinessRule` (cuando aplica y que resultado devuelve):

```js
const { BusinessRule } = require('../../../business-rule');

class CapacidadAlta extends BusinessRule {
  appliesTo({ data }) {
    return data.capacidad >= 500;
  }

  apply({ data }) {
    return { type: 'ProgramarCobertura', payload: { eventoId: data.eventoId, capacidad: data.capacidad } };
  }
}

module.exports = { CapacidadAlta };
```

No hay que registrarla: el listener carga todos los `*.rule.js` de su carpeta
al arrancar, en orden alfabetico (prefijar con `01-`, `02-`... si el orden de
los resultados importa). Un archivo que no exporte exactamente una subclase de
`BusinessRule` hace fallar el arranque del listener. Otros archivos de la
carpeta (helpers, constantes) se ignoran.

Cada `type` que devuelva una regla necesita su handler registrado en el
`OutcomeFactory` (`src/index.js`).

## Agregar un listener

1. Crear `<caso-de-negocio>/<evento>/<evento>.listener.js` extendiendo
   `EventListener`, pasando `topic` (en general desde una env var) y
   `rulesDir: path.join(__dirname, 'rules')`.
2. Sumarlo al array `listeners` del `index.js` del subpaquete.
3. Si el caso de negocio es nuevo, agregar su carpeta a `PACKAGES` en `index.js`.
4. Tests en `src/tests/listeners/<caso-de-negocio>/`.

Un error transitorio en `handle()` o en la factory hace que Kafka reentregue
el mensaje; uno permanente lo descarta (ver Errores).
