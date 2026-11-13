// Contrato AsyncAPI (asyncapi.yaml): el spec tiene que ser válido y lo que
// arman los builders de src/services/emergency-events.js tiene que cumplir
// los schemas de `data`. Si este test falla tras tocar un builder, actualizar
// asyncapi.yaml (y avisar a los consumidores: es un cambio de contrato).
const fs = require('fs');
const path = require('path');
const { Parser } = require('@asyncapi/parser');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const {
  buildEmergencyCreatedEvent,
  buildEmergencyUpdatedEvent,
  buildEmergencyPrioritizedEvent,
  STATUS_TO_ESTADO,
  SEVERITY_TO_PRIORIDAD,
} = require('../services/emergency-events');
const { EMERGENCY_TYPES } = require('../domain/emergency-type');
const { ProgramarCoberturaPreventivaRule } = require('../listeners/cobertura-preventiva/evento-comunitario-publicado/rules/01-programar-cobertura.rule');

const SPEC_PATH = path.join(__dirname, '..', '..', 'asyncapi.yaml');

describe('asyncapi.yaml', () => {
  let document;
  let diagnostics;
  let ajv;

  beforeAll(async () => {
    const parser = new Parser();
    ({ document, diagnostics } = await parser.parse(fs.readFileSync(SPEC_PATH, 'utf8')));
    ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
  });

  function schema(name) {
    return document.components().schemas().get(name).json();
  }

  function validate(name, data) {
    const ok = ajv.validate(schema(name), data);
    if (!ok) throw new Error(`${name}: ${ajv.errorsText(ajv.errors)}`);
    return true;
  }

  it('parsea sin errores', () => {
    const errors = diagnostics.filter((d) => d.severity === 0);
    expect(errors).toEqual([]);
    expect(document).toBeDefined();
  });

  it('declara los eventos publicados y consumidos', () => {
    const send = document.operations().filterBySend().map((op) => op.id());
    const receive = document.operations().filterByReceive().map((op) => op.id());
    expect(send).toEqual(expect.arrayContaining(['publicarEmergenciaCreada', 'publicarEmergenciaActualizada']));
    expect(receive).toEqual(expect.arrayContaining([
      'recibirEventoComunitarioPublicado', 'recibirEventoCancelado',
      'recibirReclamoCreado', 'recibirReclamoActualizado', 'recibirEmergenciaSolicitada',
    ]));
  });

  it('los enums del spec coinciden con el código', () => {
    expect([...schema('Estado').enum].sort()).toEqual(Object.values(STATUS_TO_ESTADO).sort());
    expect([...schema('Prioridad').enum].sort()).toEqual(Object.values(SEVERITY_TO_PRIORIDAD).sort());
    expect([...schema('Categoria').enum].sort()).toEqual([...EMERGENCY_TYPES].sort());
  });

  it('los ejemplos de los mensajes cumplen sus schemas', () => {
    for (const message of document.components().messages()) {
      const payloadSchema = message.payload().json();
      for (const example of message.examples()) {
        const ok = ajv.validate(payloadSchema, example.payload());
        if (!ok) throw new Error(`${message.id()}/${example.name()}: ${ajv.errorsText(ajv.errors)}`);
      }
    }
  });

  describe('builders vs schemas', () => {
    const emergency = {
      id: '5d1e9a7c-3b2f-4f61-9c8e-0a4b7d2e6f13',
      userId: 'CIT-JuanPanico',
      correlationId: 'c-9120',
      emergencyType: 'PANICO',
      severity: 'critical',
      status: 'PENDING',
      createdAt: '2026-11-02T22:59:08.205Z',
      updatedAt: '2026-11-02T23:05:00.000Z',
      assignedOfficerId: 'off-1',
    };

    it('EmergenciaCreada (botón de pánico)', () => {
      const event = buildEmergencyCreatedEvent(emergency, 'evt-1');
      expect(validate('EmergenciaCreadaData', event.data)).toBe(true);
    });

    it('EmergenciaCreada (cobertura preventiva, sin ciudadano)', () => {
      const event = buildEmergencyCreatedEvent({
        ...emergency,
        userId: null,
        emergencyType: 'PREVENTIVA',
        severity: 'medium',
        causaTipo: 'EVENTO_PUBLICO',
        causaId: 'evt-espacios-1',
      }, 'evt-2');
      expect(validate('EmergenciaCreadaData', event.data)).toBe(true);
    });

    it.each(Object.keys(STATUS_TO_ESTADO))('EmergenciaActualizada hacia %s', (newStatus) => {
      const event = buildEmergencyUpdatedEvent({
        emergency,
        history: { previousStatus: 'PENDING', newStatus },
        actor: 'DSP-Ana',
        reason: 'motivo',
        eventId: 'evt-3',
      });
      expect(validate('EmergenciaActualizadaData', event.data)).toBe(true);
    });

    it('EmergenciaActualizada sin actor ni motivo', () => {
      const event = buildEmergencyUpdatedEvent({
        emergency,
        history: { previousStatus: 'VALIDATED', newStatus: 'DISPATCHED' },
        eventId: 'evt-4',
      });
      expect(validate('EmergenciaActualizadaData', event.data)).toBe(true);
    });

    it('EmergenciaPriorizada', () => {
      const event = buildEmergencyPrioritizedEvent({
        emergencyId: 'em-1',
        correlationId: 'corr-1',
        incidentId: 'inc-1',
        priorityIndividual: 'low',
        incidentPriority: 'high',
        priority: 'high',
        score: 62,
        reasonCodes: ['PROXIMITY_CLUSTER'],
        algorithmVersion: 'rule-based-v1',
        eventId: 'evt-5',
      });
      expect(validate('EmergenciaPriorizadaData', event.data)).toBe(true);
    });

    it('un campo extra en EmergenciaCreada rompe el contrato', () => {
      const event = buildEmergencyCreatedEvent(emergency, 'evt-6');
      expect(() => validate('EmergenciaCreadaData', { ...event.data, descripcion: 'texto libre' })).toThrow();
    });
  });

  describe('eventos consumidos', () => {
    it('un EventoComunitarioPublicado válido según el spec dispara la regla', () => {
      const data = {
        eventoId: 'evt-espacios-1',
        titulo: 'Recital',
        latitud: -34.6,
        longitud: -58.4,
        direccion: 'Av. Siempreviva 742',
        capacidad: 1200,
        estado: 'PUBLISHED',
        correlationId: 'evento-evt-espacios-1',
      };
      expect(validate('EventoComunitarioPublicadoData', data)).toBe(true);
      expect(new ProgramarCoberturaPreventivaRule().appliesTo({ metadata: { eventId: 'x' }, data })).toBe(true);
    });

    it('EventoCancelado requiere eventoId', () => {
      expect(validate('EventoCanceladoData', { eventoId: 'evt-espacios-1', motivo: 'lluvia', canceladoEn: '2026-11-03T10:00:00Z' })).toBe(true);
      expect(() => validate('EventoCanceladoData', { motivo: 'lluvia' })).toThrow();
    });
  });
});
