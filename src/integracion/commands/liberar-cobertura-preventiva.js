const { secureLog } = require('../../security/secure-log');

// Cancela una cobertura preventiva en respuesta a un EventoCancelado
// de Espacios Publicos.
//
// Diseno:
// - El EventoCancelado trae el eventId del Publicado original (acordado con
//   Luciano al modelar los eventos). Ese eventId esta persistido como
//   correlation_id de la emergencia PENDING creada por
//   ProgramarCoberturaPreventiva.
// - UPDATE condicional con WHERE status='PENDING' AND source='EXTERNAL':
//   la cancelacion solo aplica si la cobertura sigue PENDIENTE y es externa.
//   Si el dispatcher ya la paso a VALIDATED/DISPATCHED, se decide a mano.
// - No-op si no se afectaron filas: puede pasar si el evento Publicado nunca
//   supero el umbral (no hay emergencia creada) o si ya se cancelo.
class LiberarCoberturaPreventivaCommand {
  constructor({ causationEventId }) {
    if (!causationEventId) {
      throw new Error('LiberarCoberturaPreventiva requiere causationEventId');
    }
    this.causationEventId = causationEventId;
  }

  async execute(ctx) {
    const { client } = ctx;
    if (!client) throw new Error('LiberarCoberturaPreventiva.execute requiere ctx.client');

    const result = await client.query(
      `UPDATE emergencies
          SET status = 'CANCELLED', updated_at = now(), closed_at = now()
        WHERE correlation_id = $1
          AND source = 'EXTERNAL'
          AND status = 'PENDING'
        RETURNING id`,
      [this.causationEventId]
    );

    const cancelledIds = result.rows.map((row) => row.id);
    secureLog('info', 'Liberacion de cobertura preventiva', {
      causationEventId: this.causationEventId,
      cancelledCount: cancelledIds.length,
    });

    return { cancelledCount: cancelledIds.length, cancelledIds };
  }
}

module.exports = { LiberarCoberturaPreventivaCommand };
