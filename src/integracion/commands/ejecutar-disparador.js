// Puente entre el listener (ADR #25) y los disparadores de src/disparadores:
// el mapper solo traduce el evento externo y emite este comando; qué
// responder lo decide el disparador. Corre en la transacción del listener,
// así hereda su dedup y su rollback.
class EjecutarDisparadorCommand {
  constructor({ disparador, evento }) {
    if (!disparador || typeof disparador.responder !== 'function') {
      throw new Error('EjecutarDisparador requiere un disparador con responder(evento, ctx)');
    }
    this.disparador = disparador;
    this.evento = evento;
  }

  async execute(ctx) {
    return this.disparador.responder(this.evento, ctx);
  }
}

module.exports = { EjecutarDisparadorCommand };
