const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { CONTEXTO_TIPO, ORIGEN_ESPACIOS, primerInstante } = require('../../../../domain/contexto-zona');

// El administrador de Espacios cerró la alerta: su contexto de zona se da de
// baja y las emergencias de esos barrios vuelven a su prioridad en la próxima
// lectura. Si la finalización llega antes que la confirmación, queda la marca
// y la confirmación tardía no crea el contexto (comportamiento del
// repositorio).
//
// El payload de la finalización está por confirmar: se asume data.alertaId.
class DarDeBajaContextoClimaRule extends BusinessRule {
  appliesTo(context) {
    return isUuid(context.data && context.data.alertaId);
  }

  apply(context) {
    const { data = {}, metadata = {} } = context;
    return {
      type: 'DarDeBajaContextoZona',
      payload: {
        tipo: CONTEXTO_TIPO.ALERTA_CLIMATICA,
        origen: ORIGEN_ESPACIOS,
        referenciaExterna: data.alertaId,
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
        sourceUpdatedAt: primerInstante(
          metadata.occurredAt, metadata.timestamp, metadata.receivedAt
        ) || new Date(),
      },
    };
  }
}

module.exports = { DarDeBajaContextoClimaRule };
