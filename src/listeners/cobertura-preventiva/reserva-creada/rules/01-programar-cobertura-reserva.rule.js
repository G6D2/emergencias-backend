const { BusinessRule } = require('../../../business-rule');

const UMBRAL_DEFAULT = 500;
const CAUSA_TIPO = 'RESERVA';

// Programa cobertura preventiva cuando una reserva de un espacio (plaza,
// salón, ...) junta al menos UMBRAL_PERSONAS_COBERTURA_RESERVA personas
// (env, default 500).
//
// Payload de Espacios (ReservaCreada): reservaId, tipoReserva (ESPACIO |
// EVENTO), recursoId, espacioId, categoria, zona, latitud, longitud,
// fechaHora, fechaFin, cantidadPersonas, cupoMaximo, organizadorId, createdAt
// y correlationId (= reservaId).
//
// - Solo tipoReserva ESPACIO: una inscripcion a un evento (EVENTO) es la de
//   una persona o un grupo chico, y la cobertura del evento ya la programan
//   EventoComunitarioPublicado / ActividadCreada con causa EVENTO_PUBLICO.
// - Una reserva que ya termino (fechaFin en el pasado) no programa nada: en el
//   primer deploy el listener lee el topico desde el principio y no tiene que
//   crear coberturas de reservas viejas. Sin fechaFin legible se cubre.
// - La reserva de espacio no tiene flujo de cancelacion en Espacios
//   (ReservaActualizada CANCELADA solo sale para inscripciones), asi que no
//   hay listener de baja.
class ProgramarCoberturaReservaRule extends BusinessRule {
  get umbral() {
    const v = Number(process.env.UMBRAL_PERSONAS_COBERTURA_RESERVA || UMBRAL_DEFAULT);
    return Number.isFinite(v) && v > 0 ? v : UMBRAL_DEFAULT;
  }

  terminada(fechaFin, ahora = Date.now()) {
    if (typeof fechaFin !== 'string' || !fechaFin) return false;
    const fin = Date.parse(fechaFin);
    return Number.isFinite(fin) && fin < ahora;
  }

  appliesTo(context) {
    const data = context.data || {};
    if (typeof data.reservaId !== 'string' || !data.reservaId) return false;
    if (data.tipoReserva !== 'ESPACIO') return false;
    if (this.terminada(data.fechaFin)) return false;
    const personas = Number(data.cantidadPersonas);
    return Number.isFinite(personas) && personas >= this.umbral;
  }

  apply(context) {
    const { data = {} } = context;
    const categoria = typeof data.categoria === 'string' && data.categoria ? data.categoria : null;
    return {
      type: 'ProgramarCobertura',
      payload: {
        eventoId: data.reservaId,
        causaTipo: CAUSA_TIPO,
        titulo: categoria ? `Reserva de espacio (${categoria})` : 'Reserva de espacio',
        latitud: typeof data.latitud === 'number' ? data.latitud : null,
        longitud: typeof data.longitud === 'number' ? data.longitud : null,
        direccion: null,
        // Texto libre: solo se usa si no hay coords y coincide con un barrio de CABA.
        barrio: typeof data.zona === 'string' ? data.zona : null,
        capacidad: Number(data.cantidadPersonas),
        correlationId: typeof data.correlationId === 'string' ? data.correlationId : null,
      },
    };
  }
}

module.exports = { ProgramarCoberturaReservaRule, CAUSA_TIPO };
