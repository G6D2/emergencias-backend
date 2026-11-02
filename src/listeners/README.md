# listeners

Listeners de eventos externos (Kafka). Se arrancan desde `src/index.js` con
`KAFKA_CONSUMER_ENABLED=true`.

```
listeners/
  event-listener.js            # clase abstracta: consumer, suscripcion, template method
  business-rule.js             # regla de negocio abstracta
  load-rules.js                # carga automatica de *.rule.js
  outcome-factory.js           # ejecuta los resultados en una transaccion
  handlers/                    # un handler por type de resultado
    <type>.handler.js
  index.js                     # createListeners, createOutcomeFactory + PACKAGES
  <caso-de-negocio>/           # un subpaquete por caso de negocio
    index.js                   # exporta `listeners: [ ... ]`
    <evento>/                  # una carpeta por listener
      <evento>.listener.js     # subclase de EventListener
      rules/                   # reglas de este listener, se cargan solas
        <regla>.rule.js        # una regla por archivo
```

## Flujo de un evento

`handle(event)` es un template method (no se sobreescribe):

1. `buildContext(event)` arma el contexto `{ metadata, data }`. Se puede
   sobreescribir para normalizar el evento.
2. Para cada regla de la carpeta `rules/` del listener: si
   `appliesTo(context)` da true, se agrega el resultado de `apply(context)`.
   Aplican todas las que matchean, no solo la primera.
3. Devuelve los resultados `{ type, payload }`. Las reglas no tienen side
   effects.

Despues `onMessage` le pasa los resultados a la factory (`OutcomeFactory`):

- Por cada resultado ejecuta el handler registrado para su `type`, en orden.
- Todos los resultados de un evento van en **una sola transaccion**: se aplican
  juntos o ninguno.
- Un `type` sin handler falla antes de abrir la transaccion. Un listener con
  resultados y sin factory tambien falla: un resultado nunca se pierde en
  silencio.
- Lo que tiene que salir hacia otro sistema no se llama desde el handler: se
  deja en el outbox con `PublicarEvento`.

## Agregar una regla

Crear `<evento>/rules/<regla>.rule.js` exportando una subclase de
`BusinessRule` (cuando aplica y que resultado devuelve):

```js
const { BusinessRule } = require('../../../business-rule');

class CapacidadAlta extends BusinessRule {
  appliesTo({ data }) {
    return data.capacidad >= 500;
  }

  apply({ metadata, data }) {
    return { type: 'ProgramarCoberturaPreventiva', payload: { eventId: metadata.eventId, capacidad: data.capacidad } };
  }
}

module.exports = { CapacidadAlta };
```

No hay que registrarla: el listener carga todos los `*.rule.js` de su carpeta
al arrancar, en orden alfabetico (prefijar con `01-`, `02-`... si el orden de
los resultados importa). Un archivo que no exporte exactamente una subclase de
`BusinessRule` hace fallar el arranque del listener. Otros archivos de la
carpeta (helpers, constantes) se ignoran.

## Agregar un handler

Si una regla devuelve un `type` nuevo, crear `handlers/<type>.handler.js` y
registrarlo en `createOutcomeFactory` (`index.js`). El handler recibe el client
de la transaccion, el `payload` del resultado y el contexto `{ metadata, data }`:

```js
async function miHandler(client, payload, { metadata }) {
  // escribir con este client, a traves de un repositorio
}
```

No abre otra transaccion ni hace `COMMIT`. Lo que escriba en `emergencies` tiene
que pasar por un repositorio o servicio, para no saltear el outbox, el historial
ni la validacion de transiciones.

### `PublicarEvento`

Deja un evento en el outbox. Despues lo publica el `OutboxPublisher`, igual que
el resto de nuestros eventos:

```js
return {
  type: 'PublicarEvento',
  payload: {
    topic: 'emergencias.ejemplo',
    event: { type: 'EventoEjemplo', correlationId: data.correlationId, data: { id: data.id } },
  },
};
```

El `eventId` lo asigna el outbox y el `causationId` es el `eventId` del evento
externo que lo origino.

## Agregar un listener

1. Crear `<caso-de-negocio>/<evento>/<evento>.listener.js` extendiendo
   `EventListener`, pasando `topic` (en general desde una env var) y
   `rulesDir: path.join(__dirname, 'rules')`.
2. Sumarlo al array `listeners` del `index.js` del subpaquete.
3. Si el caso de negocio es nuevo, agregar su carpeta a `PACKAGES` en `index.js`.
4. Tests en `src/tests/listeners/<caso-de-negocio>/`.

Si `handle()` o la factory lanzan, el offset no se confirma y Kafka reentrega el
mensaje.
