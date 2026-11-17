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
const { RegistrarContextoClimaRule } = require('../listeners/alerta-climatica/alerta-climatica-confirmada/rules/01-registrar-contexto-clima.rule');
const { normalizarEnvelope } = require('../listeners/alerta-climatica/envelope');
const { ProgramarCoberturaActividadRule } = require('../listeners/cobertura-preventiva/actividad-creada/rules/01-programar-cobertura.rule');
const { CrearEmergenciaBicicletaRule } = require('../listeners/movilidad-bicicleta/emergencia-bicicleta/rules/01-crear-emergencia-bicicleta.rule');
const { ProgramarCoberturaReservaRule } = require('../listeners/cobertura-preventiva/reserva-creada/rules/01-programar-cobertura-reserva.rule');

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
      'recibirActividadCreada',
      'recibirEmergenciaBicicleta', 'recibirReservaCreada',
      'recibirAlertaClimaticaConfirmada', 'recibirAlertaClimaticaFinalizada',
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

    it('una ActividadCreada válida según el spec dispara la regla', () => {
      const data = {
        actividadId: 'act-1',
        titulo: 'Festival de Primavera',
        capacidad: 1200,
        ubicacion: { lat: -34.5994, lng: -58.3988 },
        direccion: 'Av. Córdoba 2100',
        estado: 'PROGRAMADA',
        correlationId: 'act-1',
        fechaHoraInicio: Date.now() + 60 * 60 * 1000,
        fechaHoraFinalizacion: Date.now() + 3 * 60 * 60 * 1000,
      };
      expect(validate('ActividadCreadaData', data)).toBe(true);
      expect(new ProgramarCoberturaActividadRule().appliesTo({ metadata: { eventId: 'x' }, data })).toBe(true);
      expect(() => validate('ActividadCreadaData', { titulo: 'sin id' })).toThrow();
    });

    it('un ReservaCreada válido según el spec dispara la regla de reserva', () => {
      const data = {
        reservaId: 'res-1',
        tipoReserva: 'ESPACIO',
        recursoId: 'esp-1',
        espacioId: 'esp-1',
        categoria: 'PLAZA',
        zona: 'Palermo',
        latitud: -34.58,
        longitud: -58.42,
        fechaHora: '2099-01-01T18:00:00Z',
        fechaFin: '2099-01-01T23:00:00Z',
        cantidadPersonas: 800,
        cupoMaximo: 1000,
        organizadorId: null,
        createdAt: '2026-11-16T12:00:00Z',
        correlationId: 'res-1',
      };
      expect(validate('ReservaCreadaData', data)).toBe(true);
      expect(new ProgramarCoberturaReservaRule().appliesTo({ metadata: { eventId: 'x' }, data })).toBe(true);
      expect(() => validate('ReservaCreadaData', { ...data, tipoReserva: 'OTRO' })).toThrow();
    });

    it('EventoCancelado requiere eventoId', () => {
      expect(validate('EventoCanceladoData', { eventoId: 'evt-espacios-1', motivo: 'lluvia', canceladoEn: '2026-11-03T10:00:00Z' })).toBe(true);
      expect(() => validate('EventoCanceladoData', { motivo: 'lluvia' })).toThrow();
    });

    it('EmergenciaBicicleta valida el schema y conserva emergenciaId para el outcome', () => {
      const data = {
        emergenciaId: 'EMG-20261115-12345',
        actorSub: 'usuario-demo',
        reportadaEn: 1763218800000,
        ubicacion: { latitud: -34.6037, longitud: -58.3816, precisionMetros: 12.5 },
        triage: {
          respondido: true,
          puedeMoverse: false,
          estaSangrando: true,
          vehiculoInvolucrado: true,
          prioridadSugerida: 'P1',
        },
        viaje: {
          viajeId: 101,
          iniciadoEn: 1763217900000,
          estacionOrigenId: 7,
          estacionOrigenNombre: 'Estación Ejemplo',
          bicicletaId: 55,
          bicicletaCodigo: 'BIKE-0055',
        },
        usuario: { usuarioId: 42, nombre: 'Usuario', apellido: 'Demo', email: 'demo@example.invalid' },
      };
      const rule = new CrearEmergenciaBicicletaRule();

      expect(validate('EmergenciaBicicletaData', data)).toBe(true);
      expect(rule.apply({ data })).toMatchObject({
        type: 'CrearEmergenciaBicicleta',
        payload: {
          emergenciaId: 'EMG-20261115-12345',
          latitud: -34.6037,
          longitud: -58.3816,
          prioridadSugerida: 'P1',
        },
      });
      expect(rule.apply({ data }).payload).not.toHaveProperty('usuario');
    });

    it('el ejemplo de AlertaClimaticaConfirmada del spec dispara la regla y eleva', () => {
      const message = document.components().messages().get('AlertaClimaticaConfirmada');
      const [example] = message.examples().all();
      const context = normalizarEnvelope(example.payload());
      const rule = new RegistrarContextoClimaRule();

      expect(context.metadata.eventId).toBe(example.payload().eventId);
      expect(rule.appliesTo(context)).toBe(true);
      expect(rule.apply(context).payload).toMatchObject({
        tipo: 'ALERTA_CLIMATICA',
        barrios: ['PALERMO', 'VILLA CRESPO'],
        tiposEmergencia: ['INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO'],
      });
    });

    it('declara los canales reales de criticidad climática', () => {
      const receive = document.operations().filterByReceive().map((op) => op.id());
      expect(receive).toEqual(expect.arrayContaining([
        'recibirCriticidadClimaticaConfirmada', 'recibirCriticidadClimaticaFinalizada',
      ]));
      expect(document.channels().get('criticidadClimaticaConfirmada').address())
        .toBe('com.citypass.espacios.CriticidadClimaticaConfirmada');
      expect(document.channels().get('criticidadClimaticaFinalizada').address())
        .toBe('com.citypass.espacios.CriticidadClimaticaFinalizada');
    });

    it('el ejemplo de CriticidadClimaticaConfirmada (contrato real) dispara la regla y eleva', () => {
      const message = document.components().messages().get('CriticidadClimaticaConfirmada');
      const [example] = message.examples().all();
      const context = normalizarEnvelope(example.payload());
      const rule = new RegistrarContextoClimaRule();

      expect(rule.appliesTo(context)).toBe(true);
      expect(rule.apply(context).payload).toMatchObject({
        tipo: 'ALERTA_CLIMATICA',
        referenciaExterna: 'f6029e4f-e0ef-46b8-9f1a-66e814f1c90e',
        barrios: ['BALVANERA', 'SAN NICOLAS'],
        gravedad: 'ALTA',
        tiposEmergencia: ['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA'],
      });
    });

    it('CriticidadClimaticaFinalizada requiere alertaId, finalizadaEn y actorSub', () => {
      expect(validate('CriticidadClimaticaFinalizadaData', {
        alertaId: 'f6029e4f-e0ef-46b8-9f1a-66e814f1c90e', finalizadaEn: 1794625200000, actorSub: 'admin-ejemplo',
      })).toBe(true);
      expect(() => validate('CriticidadClimaticaFinalizadaData', { alertaId: 'f6029e4f-e0ef-46b8-9f1a-66e814f1c90e' })).toThrow();
    });

    it('AlertaClimaticaFinalizada requiere alertaId', () => {
      expect(validate('AlertaClimaticaFinalizadaData', { alertaId: '0b0e5c1a-7f3e-4a8e-9a51-2d5f1c7e9b10' })).toBe(true);
      expect(() => validate('AlertaClimaticaFinalizadaData', {})).toThrow();
    });
  });
});
