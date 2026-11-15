const { ValidationError } = require('../../../../errors/app-errors');
const { BusinessRule } = require('../../../business-rule');

const PRIORIDADES = new Set(['P1', 'P2', 'P3', 'P4']);

class CrearEmergenciaBicicletaRule extends BusinessRule {
  appliesTo() {
    return true;
  }

  apply({ data = {} }) {
    const emergenciaId = data.emergenciaId;
    if (typeof emergenciaId !== 'string' || !emergenciaId || emergenciaId !== emergenciaId.trim()) {
      throw new ValidationError('EmergenciaBicicleta requiere data.emergenciaId no vacío');
    }

    const { latitud, longitud } = data.ubicacion || {};
    if (
      typeof latitud !== 'number'
      || !Number.isFinite(latitud)
      || latitud < -90
      || latitud > 90
      || typeof longitud !== 'number'
      || !Number.isFinite(longitud)
      || longitud < -180
      || longitud > 180
    ) {
      throw new ValidationError('EmergenciaBicicleta requiere coordenadas válidas en data.ubicacion');
    }

    const triage = data.triage || {};
    const prioridadSugerida = triage.prioridadSugerida;
    if (!PRIORIDADES.has(prioridadSugerida)) {
      throw new ValidationError('EmergenciaBicicleta requiere triage.prioridadSugerida P1, P2, P3 o P4');
    }

    return {
      type: 'CrearEmergenciaBicicleta',
      payload: {
        emergenciaId,
        latitud,
        longitud,
        prioridadSugerida,
        triage: {
          respondido: triage.respondido,
          puedeMoverse: triage.puedeMoverse,
          estaSangrando: triage.estaSangrando,
          vehiculoInvolucrado: triage.vehiculoInvolucrado,
        },
        viajeId: data.viaje && data.viaje.viajeId,
        bicicletaCodigo: data.viaje && data.viaje.bicicletaCodigo,
      },
    };
  }
}

module.exports = { CrearEmergenciaBicicletaRule };
