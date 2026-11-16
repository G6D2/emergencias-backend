const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { ORIGEN_ESPACIOS, primerInstante, ventanaDeVigencia } = require('../../../../domain/contexto-zona');
const {
  alertaIdValido,
  nivelNormalizado,
  radioClimaMetros,
  ubicacionesDeLaAlerta,
} = require('../../../../domain/alerta-climatica');

const MAX_DESCRIPCION_LENGTH = 200;

// Un contexto de zona ALERTA_CLIMATICA por cada punto de `ubicaciones`, con
// la ventana vigenciaDesde–vigenciaHasta (sin fin, la duración por defecto).
// Mientras está en curso, las emergencias que se crean a no más de
// CONTEXTO_ZONA_RADIO_CLIMA_METROS de un punto suben un nivel de prioridad
// de despacho. Aplica a cualquier nivel confirmado. Una alerta sin
// ubicaciones válidas no deja contextos (`barrios` solo no ubica nada).
class RegistrarContextosClimaticosRule extends BusinessRule {
  appliesTo({ data = {} }) {
    return alertaIdValido(data.alertaId) && ubicacionesDeLaAlerta(data).length > 0;
  }

  apply({ data = {}, metadata = {} }) {
    const ahora = new Date();
    const nivel = nivelNormalizado(data.nivelCriticidad);
    const fenomeno = typeof data.fenomeno === 'string' && data.fenomeno.trim()
      ? data.fenomeno.trim().replace(/_/g, ' ').toLowerCase()
      : 'evento climático';
    return {
      type: 'RegistrarContextosClimaticos',
      payload: {
        origen: ORIGEN_ESPACIOS,
        alertaId: data.alertaId,
        ubicaciones: ubicacionesDeLaAlerta(data).map(({ indice, punto }) => ({ indice, ...punto })),
        radioMetros: radioClimaMetros(),
        ...ventanaDeVigencia({ inicio: data.vigenciaDesde, fin: data.vigenciaHasta, ahora }),
        descripcion: `Alerta climática${nivel ? ` ${nivel}` : ''}: ${fenomeno}`.slice(0, MAX_DESCRIPCION_LENGTH),
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
        sourceUpdatedAt: primerInstante(
          data.confirmadaEn, metadata.occurredAt, metadata.timestamp, metadata.receivedAt
        ) || ahora,
      },
    };
  }
}

module.exports = { RegistrarContextosClimaticosRule };
