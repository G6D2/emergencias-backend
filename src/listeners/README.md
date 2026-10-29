# listeners

Listeners de eventos externos (Kafka). Se arrancan desde `src/index.js` con
`KAFKA_CONSUMER_ENABLED=true`.

```
listeners/
  event-listener.js        # clase abstracta: consumer, suscripcion, parseo
  index.js                 # createListeners(kafka) + PACKAGES
  <caso-de-negocio>/       # un subpaquete por caso de negocio
    index.js               # exporta `listeners: [ ... ]`
    <evento>.listener.js   # una subclase de EventListener por evento
```

## Agregar un listener

1. Crear `<caso-de-negocio>/<evento>.listener.js` extendiendo `EventListener`:
   pasar el `topic` (en general desde una env var) e implementar `handle(event)`.
2. Sumarlo al array `listeners` del `index.js` del subpaquete.
3. Si el caso de negocio es nuevo, agregar su carpeta a `PACKAGES` en `index.js`.
4. Tests en `src/tests/listeners/<caso-de-negocio>/`.

Si `handle()` lanza, el offset no se confirma y Kafka reentrega el mensaje.
