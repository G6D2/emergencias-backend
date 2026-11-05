const { BusinessRule } = require('../../../business-rule');

// Libera la cobertura preventiva cuando Espacios cancela el evento
// comunitario (EventoCancelado: eventoId, motivo, canceladoEn).
class CancelarCoberturaPreventivaRule extends BusinessRule {
  appliesTo(context) {
    const eventoId = context.data && context.data.eventoId;
    return typeof eventoId === 'string' && eventoId.length > 0;
  }

  apply(context) {
    return {
      type: 'CancelarCobertura',
      payload: { eventoId: context.data.eventoId },
    };
  }
}

module.exports = { CancelarCoberturaPreventivaRule };
