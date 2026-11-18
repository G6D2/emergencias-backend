const { BusinessRule } = require('../../../business-rule');
const { isUuid } = require('../../../../utils/uuid');
const { ORIGEN_ESPACIOS, primerInstante, ventanaDeVigencia } = require('../../../../domain/contexto-zona');
const {
  alertaIdValido,
  esNivelAccionable,
  fenomenoLegible,
  fenomenoNormalizado,
  nivelNormalizado,
  radioClimaMetros,
  zonasDeLaAlerta,
} = require('../../../../domain/alerta-climatica');

const MAX_DESCRIPCION_LENGTH = 200;

// Con nivel ALTA o CRITICA, contextos de zona ALERTA_CLIMATICA con la ventana
// vigenciaDesde–vigenciaHasta (sin fin, la duración por defecto). Mientras
// están en curso, las emergencias que se crean dentro de su zona suben un
// nivel de prioridad de despacho. BAJA y MEDIA no registran nada.
//
// - Zona por barrio: un contexto por cada barrio de `barrios` que está en el
//   catálogo, con el círculo que cubre el barrio. Al vincular, la emergencia
//   además tiene que ser de ese barrio (linkZoneContexts), así el círculo no
//   alcanza a los vecinos.
// - Zona por punto, si no viene ningún barrio del catálogo: un contexto por
//   cada punto de `ubicaciones`, con el radio del nivel
//   (CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS, default 1000;
//   CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS, default 500).
// Una alerta sin barrios del catálogo ni ubicaciones válidas no deja contextos.
//
// Cada contexto guarda además nivel y fenómeno (V33), para el banner.
class RegistrarContextosClimaticosRule extends BusinessRule {
  appliesTo({ data = {} }) {
    const nivel = nivelNormalizado(data.nivelCriticidad);
    return alertaIdValido(data.alertaId)
      && esNivelAccionable(nivel)
      && zonasDeLaAlerta(data, nivel).length > 0;
  }

  apply({ data = {}, metadata = {} }) {
    const ahora = new Date();
    const nivel = nivelNormalizado(data.nivelCriticidad);
    return {
      type: 'RegistrarContextosClimaticos',
      payload: {
        origen: ORIGEN_ESPACIOS,
        alertaId: data.alertaId,
        // Cada zona trae su radio (el del barrio o el del nivel) y su barrio
        // (null en la zona por punto).
        ubicaciones: zonasDeLaAlerta(data, nivel),
        // Radio del nivel: el de las zonas por punto.
        radioMetros: radioClimaMetros(nivel),
        ...ventanaDeVigencia({ inicio: data.vigenciaDesde, fin: data.vigenciaHasta, ahora }),
        descripcion: `Alerta climática ${nivel}: ${fenomenoLegible(data.fenomeno)}`.slice(0, MAX_DESCRIPCION_LENGTH),
        nivel,
        fenomeno: fenomenoNormalizado(data.fenomeno),
        causationId: isUuid(metadata.eventId) ? metadata.eventId : null,
        // El evento de Espacios no trae fecha de confirmación: vale la del envelope.
        sourceUpdatedAt: primerInstante(metadata.occurredAt, metadata.timestamp, metadata.receivedAt) || ahora,
      },
    };
  }
}

module.exports = { RegistrarContextosClimaticosRule };
