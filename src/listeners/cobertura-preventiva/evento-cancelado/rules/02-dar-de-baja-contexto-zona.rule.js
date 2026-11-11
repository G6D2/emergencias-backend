const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { CONTEXTO_TIPO, ORIGEN_ESPACIOS, primerInstante } = require('../../../../domain/contexto-zona');

// Espacios canceló el evento comunitario: su contexto de zona se da de baja
// y las emergencias del barrio dejan de subir de prioridad en la próxima
// lectura. Si la cancelación llega antes que la publicación, queda la marca
// y la publicación tardía no crea el contexto.
class DarDeBajaContextoZonaRule extends BusinessRule {
  appliesTo(context) {
    const eventoId = context.data && context.data.eventoId;
    return typeof eventoId === 'string' && eventoId.length > 0;
  }

  apply(context) {
    const { data = {}, metadata = {} } = context;
    return {
      type: 'DarDeBajaContextoZona',
      payload: {
        tipo: CONTEXTO_TIPO.EVENTO_ESPACIO_PUBLICO,
        origen: ORIGEN_ESPACIOS,
        referenciaExterna: data.eventoId,
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
        sourceUpdatedAt: primerInstante(
          data.canceladoEn, metadata.occurredAt, metadata.timestamp, metadata.receivedAt
        ) || new Date(),
      },
    };
  }
}

module.exports = { DarDeBajaContextoZonaRule };
