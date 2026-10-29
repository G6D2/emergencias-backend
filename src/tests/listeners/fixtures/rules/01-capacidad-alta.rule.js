const { BusinessRule } = require('../../../../listeners/business-rule');

class CapacidadAlta extends BusinessRule {
  appliesTo({ data }) {
    return data.capacidad >= 500;
  }

  apply({ metadata, data }) {
    return { type: 'CapacidadAlta', payload: { eventId: metadata.eventId, capacidad: data.capacidad } };
  }
}

module.exports = { CapacidadAlta, UMBRAL: 500 };
