const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { ORIGEN_ESPACIOS, primerInstante, ventanaDeVigencia } = require('../../../../domain/contexto-zona');
const {
  alertaIdValido,
  barriosParaMostrar,
  esNivelAccionable,
  fenomenoLegible,
  fenomenoNormalizado,
  nivelNormalizado,
  radioClimaMetros,
  ubicacionesDeLaAlerta,
} = require('../../../../domain/alerta-climatica');

const MAX_DESCRIPCION_LENGTH = 200;

// Con nivel ALTA o CRITICA, un contexto de zona ALERTA_CLIMATICA por cada
// punto de `ubicaciones`, con la ventana vigenciaDesde–vigenciaHasta (sin
// fin, la duración por defecto). Mientras está en curso, las emergencias que
// se crean dentro del radio del nivel (CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS,
// default 1000; CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS, default 500) suben un
// nivel de prioridad de despacho. BAJA y MEDIA no registran nada. Una alerta
// sin ubicaciones válidas no deja contextos (`barrios` no define zona).
//
// Cada contexto guarda además nivel, fenómeno y barrios de la alerta (V33),
// solo para mostrarla en el banner del tablero: no cambian la zona ni la suba.
class RegistrarContextosClimaticosRule extends BusinessRule {
  appliesTo({ data = {} }) {
    return alertaIdValido(data.alertaId)
      && esNivelAccionable(nivelNormalizado(data.nivelCriticidad))
      && ubicacionesDeLaAlerta(data).length > 0;
  }

  apply({ data = {}, metadata = {} }) {
    const ahora = new Date();
    const nivel = nivelNormalizado(data.nivelCriticidad);
    return {
      type: 'RegistrarContextosClimaticos',
      payload: {
        origen: ORIGEN_ESPACIOS,
        alertaId: data.alertaId,
        ubicaciones: ubicacionesDeLaAlerta(data).map(({ indice, punto }) => ({ indice, ...punto })),
        radioMetros: radioClimaMetros(nivel),
        ...ventanaDeVigencia({ inicio: data.vigenciaDesde, fin: data.vigenciaHasta, ahora }),
        descripcion: `Alerta climática ${nivel}: ${fenomenoLegible(data.fenomeno)}`.slice(0, MAX_DESCRIPCION_LENGTH),
        nivel,
        fenomeno: fenomenoNormalizado(data.fenomeno),
        barrios: barriosParaMostrar(data),
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
        // El evento de Espacios no trae fecha de confirmación: vale la del envelope.
        sourceUpdatedAt: primerInstante(metadata.occurredAt, metadata.timestamp, metadata.receivedAt) || ahora,
      },
    };
  }
}

module.exports = { RegistrarContextosClimaticosRule };
