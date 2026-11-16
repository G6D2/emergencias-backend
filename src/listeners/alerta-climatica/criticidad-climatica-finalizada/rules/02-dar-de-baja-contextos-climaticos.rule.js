const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { ORIGEN_ESPACIOS, primerInstante } = require('../../../../domain/contexto-zona');
const { alertaIdValido } = require('../../../../domain/alerta-climatica');

// La alerta terminó: sus contextos de zona se dan de baja y las emergencias
// cercanas dejan de subir de prioridad. Si la finalización llega antes que la
// confirmación, queda la marca y la confirmación tardía no crea contextos.
class DarDeBajaContextosClimaticosRule extends BusinessRule {
  appliesTo({ data = {} }) {
    return alertaIdValido(data.alertaId);
  }

  apply({ data = {}, metadata = {} }) {
    return {
      type: 'DarDeBajaContextosClimaticos',
      payload: {
        origen: ORIGEN_ESPACIOS,
        alertaId: data.alertaId,
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
        sourceUpdatedAt: primerInstante(
          data.finalizadaEn, metadata.occurredAt, metadata.timestamp, metadata.receivedAt
        ) || new Date(),
      },
    };
  }
}

module.exports = { DarDeBajaContextosClimaticosRule };
