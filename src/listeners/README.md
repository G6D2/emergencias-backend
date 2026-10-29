# listeners

Listeners de eventos externos (Kafka). Se arrancan desde `src/index.js` con
`KAFKA_CONSUMER_ENABLED=true`.

```
listeners/
  event-listener.js            # clase abstracta: consumer, suscripcion, template method
  business-rule.js             # regla de negocio abstracta
  load-rules.js                # carga automatica de *.rule.js
  index.js                     # createListeners(kafka) + PACKAGES
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
3. Devuelve los resultados `{ type, payload }`. Despues los toma una factory
   que, segun el `type`, arma los POST y las escrituras en base del caso de
   negocio. Las reglas no tienen side effects.

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

## Agregar un listener

1. Crear `<caso-de-negocio>/<evento>/<evento>.listener.js` extendiendo
   `EventListener`, pasando `topic` (en general desde una env var) y
   `rulesDir: path.join(__dirname, 'rules')`.
2. Sumarlo al array `listeners` del `index.js` del subpaquete.
3. Si el caso de negocio es nuevo, agregar su carpeta a `PACKAGES` en `index.js`.
4. Tests en `src/tests/listeners/<caso-de-negocio>/`.

Si `handle()` lanza, el offset no se confirma y Kafka reentrega el mensaje.
