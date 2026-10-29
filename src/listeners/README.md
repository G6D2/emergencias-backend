# listeners

Listeners de eventos externos (Kafka). Se arrancan desde `src/index.js` con
`KAFKA_CONSUMER_ENABLED=true`.

```
listeners/
  event-listener.js        # clase abstracta: consumer, suscripcion, parseo, template method
  business-rule.js         # regla de negocio abstracta
  index.js                 # createListeners(kafka) + PACKAGES
  <caso-de-negocio>/       # un subpaquete por caso de negocio
    index.js               # exporta `listeners: [ ... ]`
    <evento>.listener.js   # una subclase de EventListener por evento
    rules/                 # reglas (subclases de BusinessRule) del caso
```

## Flujo de un evento

`handle(event)` es un template method (no se sobreescribe):

1. `buildContext(event)` arma el contexto `{ metadata, data }`. Se puede
   sobreescribir para normalizar el evento.
2. Para cada regla de `rules()` (obligatorio en cada listener): si
   `appliesTo(context)` da true, se agrega el resultado de `apply(context)`.
3. Devuelve los resultados `{ type, payload }`. Despues los toma una factory
   que, segun el `type`, arma los POST y las escrituras en base del caso de
   negocio. Las reglas no tienen side effects.

## Agregar un listener

1. Crear `<caso-de-negocio>/<evento>.listener.js` extendiendo `EventListener`:
   pasar el `topic` (en general desde una env var) e implementar `rules()`.
   Las reglas van en `<caso-de-negocio>/rules/`, extendiendo `BusinessRule`.
2. Sumarlo al array `listeners` del `index.js` del subpaquete.
3. Si el caso de negocio es nuevo, agregar su carpeta a `PACKAGES` en `index.js`.
4. Tests en `src/tests/listeners/<caso-de-negocio>/`.

Si `handle()` lanza, el offset no se confirma y Kafka reentrega el mensaje.
