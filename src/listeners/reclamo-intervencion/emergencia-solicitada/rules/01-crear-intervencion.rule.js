const { BusinessRule } = require('../../../business-rule');
const { creaConEmergenciaSolicitada } = require('../../disparador');

// El handler antepone "Reclamo por ciclovía obstruida — " y corta en 200.
const MAX_TITULO_LENGTH = 160;

function texto(value) {
  return typeof value === 'string' ? value : null;
}

// Movilidad pide una emergencia por un reclamo de ciclovía: se crea la misma
// intervención que crearía el ReclamoCreado, con el reclamo como causa.
//
// Payload de Movilidad (EmergenciaSolicitada): reclamoId, correlationId,
// origen, tipoEmergencia (hoy solo OBSTRUCCION_CICLOVIA_CRITICA), prioridad,
// descripcion, direccion, latitud, longitud y solicitadoAt (epoch ms). No trae
// barrio: se resuelve por las coordenadas. Movilidad lo publica una vez por
// reclamo, si es de ciclovía, afecta la circulación, tiene prioridad ALTA o
// CRITICA y no está en revisión; acá no se vuelve a evaluar.
class CrearIntervencionPorSolicitudRule extends BusinessRule {
  appliesTo(context) {
    const data = context.data || {};
    if (!creaConEmergenciaSolicitada(context.disparador)) return false;
    return typeof data.reclamoId === 'string' && data.reclamoId.trim() !== '';
  }

  apply(context) {
    const { data = {} } = context;
    const descripcion = (texto(data.descripcion) || '').trim().slice(0, MAX_TITULO_LENGTH).trim();
    return {
      type: 'CrearIntervencionPorReclamo',
      payload: {
        reclamoId: data.reclamoId,
        titulo: descripcion || null,
        prioridad: texto(data.prioridad),
        latitud: typeof data.latitud === 'number' ? data.latitud : null,
        longitud: typeof data.longitud === 'number' ? data.longitud : null,
        direccion: texto(data.direccion),
        barrio: null,
        correlationId: texto(data.correlationId),
      },
    };
  }
}

module.exports = { CrearIntervencionPorSolicitudRule };
