const { BusinessRule } = require('../../../business-rule');
const { ESTADOS_FINALES, CATEGORIA_TRANSITO, OBJETO_CICLOVIA, normalizar } = require('../../reclamo');
const { creaConReclamoCreado } = require('../../disparador');

// Un reclamo de tránsito sobre una ciclovía (auto estacionado, obstrucción)
// pide una intervención de Emergencias.
//
// Plan B del caso: solo aplica con RECLAMO_INTERVENCION_DISPARADOR en reclamo
// o ambos. Con el default (movilidad) la intervención la crea la
// EmergenciaSolicitada de Movilidad y esta regla no hace nada.
//
// Payload de Reclamos (ReclamoCreado v3): reclamoId, categoria, objetoAfectado,
// prioridad, estado, titulo, direccion, barrio, latitud, longitud,
// afectaCirculacion, correlationId y createdAt (epoch ms). objetoAfectado lo
// elige el vecino y puede venir null: ese reclamo no dispara nada.
class CrearIntervencionPorReclamoRule extends BusinessRule {
  appliesTo(context) {
    const data = context.data || {};
    if (!creaConReclamoCreado(context.disparador)) return false;
    if (typeof data.reclamoId !== 'string' || !data.reclamoId) return false;
    if (normalizar(data.categoria) !== CATEGORIA_TRANSITO) return false;
    if (normalizar(data.objetoAfectado) !== OBJETO_CICLOVIA) return false;
    // Al releer el tópico puede llegar el alta de un reclamo que ya terminó.
    return !ESTADOS_FINALES.has(normalizar(data.estado));
  }

  apply(context) {
    const { data = {} } = context;
    return {
      type: 'CrearIntervencionPorReclamo',
      payload: {
        reclamoId: data.reclamoId,
        titulo: typeof data.titulo === 'string' ? data.titulo : null,
        prioridad: typeof data.prioridad === 'string' ? data.prioridad : null,
        latitud: typeof data.latitud === 'number' ? data.latitud : null,
        longitud: typeof data.longitud === 'number' ? data.longitud : null,
        direccion: typeof data.direccion === 'string' ? data.direccion : null,
        barrio: typeof data.barrio === 'string' ? data.barrio : null,
        correlationId: typeof data.correlationId === 'string' ? data.correlationId : null,
      },
    };
  }
}

module.exports = { CrearIntervencionPorReclamoRule };
