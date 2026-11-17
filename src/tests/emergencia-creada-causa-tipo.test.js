// El enum de causaTipo de docs/contratos/emergencia-creada.schema.json tiene que
// incluir cada causa que el backend publica en EmergenciaCreada. Antes
// MOVILIDAD_BICICLETA salía al bus y el contrato no la tenía.
const { randomUUID } = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schema = require('../../docs/contratos/emergencia-creada.schema.json');
const { buildEmergencyCreatedEvent } = require('../services/emergency-events');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// Dónde nace cada causa:
// - RECLAMO: listeners/reclamo-intervencion (intervención por la ciclovía)
// - EVENTO_PUBLICO y RESERVA: listeners/cobertura-preventiva
// - MOVILIDAD_BICICLETA: listeners/movilidad-bicicleta
// - EVENTO_CLIMATICO: listeners/alerta-climatica
const CAUSAS_PUBLICADAS = ['RECLAMO', 'EVENTO_PUBLICO', 'RESERVA', 'MOVILIDAD_BICICLETA', 'EVENTO_CLIMATICO'];

const EMERGENCY = {
  id: '7b0d7b3e-6a4f-4a5e-9a59-1f6f1c1b2a3c',
  correlationId: '7b0d7b3e-6a4f-4a5e-9a59-1f6f1c1b2a3c',
  userId: null,
  emergencyType: 'TRANSITO',
  severity: 'high',
  status: 'PENDING',
  assignedOfficerId: null,
  createdAt: new Date('2026-11-17T12:00:00.000Z'),
  updatedAt: new Date('2026-11-17T12:00:00.000Z'),
};

const errorsOf = (event) => (validate(event) ? [] : validate.errors.map((e) => `${e.instancePath} ${e.message}`));

describe('causaTipo de EmergenciaCreada contra el contrato', () => {
  it('el enum del contrato incluye cada causa que publica el backend', () => {
    const enumCausas = schema.properties.data.properties.causaTipo.enum;
    expect(enumCausas).toEqual(expect.arrayContaining(CAUSAS_PUBLICADAS));
  });

  it.each(CAUSAS_PUBLICADAS)('el builder real arma un EmergenciaCreada válido con causaTipo %s', (causaTipo) => {
    const event = JSON.parse(JSON.stringify(buildEmergencyCreatedEvent(
      { ...EMERGENCY, causaTipo, causaId: 'causa-1' },
      randomUUID(),
    )));
    expect(event.data.causaTipo).toBe(causaTipo);
    expect(errorsOf(event)).toEqual([]);
  });

  it('una causa que no está en el contrato no pasa', () => {
    const event = JSON.parse(JSON.stringify(buildEmergencyCreatedEvent(
      { ...EMERGENCY, causaTipo: 'INVENTADA', causaId: 'causa-1' },
      randomUUID(),
    )));
    expect(errorsOf(event)).not.toEqual([]);
  });
});
