const { LiberarCoberturaPreventivaCommand } = require('../commands/liberar-cobertura-preventiva');

// Mapper puro de EventoCancelado (Espacios Publicos).
//
// Para encontrar la cobertura preventiva creada por el EventoComunitarioPublicado
// original, necesitamos su eventId: ese valor esta persistido como
// correlation_id en la emergencia. Buscamos en data primero (TODO: Luciano
// confirmara el nombre exacto del campo cuando registre el event type;
// hoy aceptamos tres variantes razonables: eventoOriginalId, eventoPublicadoId,
// causationEventId) y caemos a metadata.causationId del envelope del gateway
// si Luciano opta por propagarlo ahi.
//
// Si no hay forma de identificar al evento origen, devolvemos [] (el mapper
// no decide de que emergencia cancelar sin un ID claro).
function createEventoCanceladoMapper() {
  return function mapEventoCancelado({ metadata, data }) {
    const causationEventId =
      (data && (data.eventoOriginalId || data.eventoPublicadoId || data.causationEventId)) ||
      (metadata && metadata.causationId) ||
      null;

    if (!causationEventId) {
      return [];
    }

    return [new LiberarCoberturaPreventivaCommand({ causationEventId })];
  };
}

module.exports = { createEventoCanceladoMapper };
