const { BusinessRule } = require('../../../business-rule');
const { ESTADOS_FINALES, normalizar } = require('../../reclamo');

// El reclamo llegó a un estado final: si la intervención todavía no salió, ya
// no hace falta. Para cualquier otro cambio de estado no hay nada que hacer.
class CerrarIntervencionPorReclamoRule extends BusinessRule {
  appliesTo(context) {
    const data = context.data || {};
    if (typeof data.reclamoId !== 'string' || !data.reclamoId) return false;
    return ESTADOS_FINALES.has(normalizar(data.estadoNuevo));
  }

  apply(context) {
    const { data } = context;
    return {
      type: 'CerrarIntervencionPorReclamo',
      payload: { reclamoId: data.reclamoId, estado: normalizar(data.estadoNuevo) },
    };
  }
}

module.exports = { CerrarIntervencionPorReclamoRule };
