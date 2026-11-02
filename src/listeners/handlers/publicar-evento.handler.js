const PUBLICAR_EVENTO = 'PublicarEvento';

// Deja un evento en el outbox, en la transaccion de la factory. Despues lo
// publica el OutboxPublisher, igual que el resto de nuestros eventos.
//
// payload: { topic, event }, donde event es el cuerpo a publicar
// ({ type, correlationId, data }). El eventId lo asigna insertOutboxEvent y el
// causationId es el eventId del evento externo que lo origino.
function createPublicarEventoHandler(emergencyRepository) {
  return async function publicarEvento(client, { topic, event } = {}, { metadata = {} } = {}) {
    if (typeof topic !== 'string' || !topic) {
      throw new Error(`${PUBLICAR_EVENTO} requiere topic`);
    }
    if (!event || typeof event.type !== 'string' || !event.type) {
      throw new Error(`${PUBLICAR_EVENTO} requiere event con type`);
    }
    await emergencyRepository.insertOutboxEvent(client, {
      topic,
      payload: { ...event, causationId: metadata.eventId ?? null },
    });
  };
}

module.exports = { PUBLICAR_EVENTO, createPublicarEventoHandler };
