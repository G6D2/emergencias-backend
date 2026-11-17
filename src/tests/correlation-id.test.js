// correlationId externo (issue #77 del board): se conserva aunque no sea UUID
// y el EmergenciaCreada que sale con él cumple el contrato.
const { randomUUID } = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schema = require('../../docs/contratos/emergencia-creada.schema.json');
const { MAX_CORRELATION_ID_LENGTH, correlationIdExterno } = require('../domain/correlation-id');
const { buildEmergencyCreatedEvent } = require('../services/emergency-events');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe('correlationIdExterno', () => {
  it.each([
    'evento-ev-77',
    'act-festival-1',
    'EMG-20261115-12345',
    'res-700',
    '6f1c9a4e-3c2b-4a5d-9e11-2b7d5c8a1f30',
    'reclamo ñandú #12',
    'x'.repeat(MAX_CORRELATION_ID_LENGTH),
  ])('conserva %s tal cual', (value) => {
    expect(correlationIdExterno(value)).toBe(value);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['un número', 42],
    ['un objeto', { id: 'x' }],
    ['vacío', ''],
    ['solo espacios', ' \t '],
    ['más largo que el máximo', 'x'.repeat(MAX_CORRELATION_ID_LENGTH + 1)],
    ['un salto de línea', 'evento-1\nlog falso'],
    ['un NUL', 'evento-1\u0000'],
    ['un DEL', 'evento-1\u007f'],
    ['un control C1', 'evento-1\u0085'],
  ])('devuelve null con %s', (_caso, value) => {
    expect(correlationIdExterno(value)).toBeNull();
  });

  it('el máximo es 128', () => {
    expect(MAX_CORRELATION_ID_LENGTH).toBe(128);
  });
});

describe('EmergenciaCreada con correlationId externo contra el contrato', () => {
  const emergency = {
    id: '7b0d7b3e-6a4f-4a5e-9a59-1f6f1c1b2a3c',
    userId: null,
    emergencyType: 'PREVENTIVA',
    severity: 'low',
    status: 'PENDING',
    causaTipo: 'EVENTO_PUBLICO',
    causaId: 'ev-77',
    createdAt: new Date('2026-11-17T12:00:00.000Z'),
  };

  it.each(['evento-ev-77', 'x'.repeat(MAX_CORRELATION_ID_LENGTH)])('acepta %s en el sobre y en data', (correlationId) => {
    const event = JSON.parse(JSON.stringify(buildEmergencyCreatedEvent(
      { ...emergency, correlationId: correlationIdExterno(correlationId) },
      randomUUID(),
      { busCrypto: null },
    )));

    expect(event.correlationId).toBe(correlationId);
    expect(event.data.correlationId).toBe(correlationId);
    expect(validate(event) ? [] : validate.errors).toEqual([]);
  });
});
