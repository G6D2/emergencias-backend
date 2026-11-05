const {
  buildEmergencyCreatedEvent,
  buildEmergencyUpdatedEvent,
  buildEmergencyPrioritizedEvent,
} = require('../services/emergency-events');
const { createBusLocationCrypto, setBusLocationCryptoForTests } = require('../security/bus-location-crypto');

const BUS_TEST_KEY = Buffer.alloc(32, 9).toString('base64');

describe('emergency-events', () => {
  beforeEach(() => {
    setBusLocationCryptoForTests(null);
  });

  afterEach(() => {
    setBusLocationCryptoForTests(undefined);
  });

  describe('buildEmergencyCreatedEvent - contrato cerrado 2026-11-02 (issue #48)', () => {
    const baseEmergency = {
      id: '5d1e9a7c-3b2f-4f61-9c8e-0a4b7d2e6f13',
      userId: 'CIT-JuanPanico',
      correlationId: 'c-9120',
      emergencyType: 'PANICO',
      severity: 'critical',
      status: 'PENDING',
      createdAt: '2026-11-02T22:59:08.205Z',
      description: 'ignora texto libre',
      address: 'ignora direccion',
      updatedAt: '2026-11-02T22:59:08.205Z',
      assignedOfficerId: 'ignora oficial asignado',
    };

    it('renombra campos del contrato: emergenciaId, categoria, prioridad, estado, ciudadanoId', () => {
      const event = buildEmergencyCreatedEvent(baseEmergency, 'evt-1');
      expect(event.type).toBe('EmergenciaCreada');
      expect(event.data.emergenciaId).toBe(baseEmergency.id);
      expect(event.data.categoria).toBe('PANICO');
      expect(event.data.prioridad).toBe('CRITICA');
      expect(event.data.estado).toBe('PENDIENTE');
      expect(event.data.ciudadanoId).toBe('CIT-JuanPanico');
      expect(event.data.correlationId).toBe('c-9120');
      expect(event.data.createdAt).toBe('2026-11-02T22:59:08.205Z');
    });

    it('no publica los nombres viejos ni texto libre ni direccion', () => {
      const event = buildEmergencyCreatedEvent(baseEmergency, 'evt-2');
      expect(event.data.id).toBeUndefined();
      expect(event.data.userId).toBeUndefined();
      expect(event.data.emergencyType).toBeUndefined();
      expect(event.data.severity).toBeUndefined();
      expect(event.data.status).toBeUndefined();
      expect(event.data.description).toBeUndefined();
      expect(event.data.address).toBeUndefined();
      expect(event.data.hasDescription).toBeUndefined();
      expect(event.data.assignedOfficerId).toBeUndefined();
      expect(event.data.updatedAt).toBeUndefined();
    });

    it('publica los campos nuevos del contrato con default null/false hasta que se desbloqueen', () => {
      const event = buildEmergencyCreatedEvent(baseEmergency, 'evt-3');
      expect(event.data.barrio).toBeNull();
      expect(event.data.ubicacion.barrio).toBeNull();
      expect(event.data.ubicacion.latitud).toBeNull();
      expect(event.data.ubicacion.longitud).toBeNull();
      expect(event.data.latitud).toBeUndefined();
      expect(event.data.longitud).toBeUndefined();
      // Null hasta que se consuman eventos de otros modulos (#77/#79/#80).
      expect(event.data.causaId).toBeNull();
      expect(event.data.causaTipo).toBeNull();
      expect(event.data.prioridadOriginal).toBeNull();
      // Null hasta #85: false haria que Reclamos descarte el evento.
      expect(event.data.afectaCirculacion).toBeNull();
    });

    it('publica barrio plano y anidado cuando la emergencia lo trae', () => {
      const event = buildEmergencyCreatedEvent({ ...baseEmergency, barrio: 'PALERMO' }, 'evt-barrio');
      expect(event.data.barrio).toBe('PALERMO');
      expect(event.data.ubicacion).toEqual({
        barrio: 'PALERMO',
        latitud: null,
        longitud: null,
      });
    });

    it('cifra coords solo en ubicacion (sin campos planos); AAD ata emergenciaId+campo', () => {
      const busCrypto = createBusLocationCrypto({
        keys: { bus1: BUS_TEST_KEY },
        activeKeyId: 'bus1',
      });
      const event = buildEmergencyCreatedEvent(
        {
          ...baseEmergency,
          barrio: 'PALERMO',
          latitude: -34.5735,
          longitude: -58.4233,
        },
        'evt-coords',
        { busCrypto }
      );

      expect(event.data.barrio).toBe('PALERMO');
      expect(event.data.latitud).toBeUndefined();
      expect(event.data.longitud).toBeUndefined();
      expect(event.data.ubicacion.barrio).toBe('PALERMO');
      expect(typeof event.data.ubicacion.latitud).toBe('string');
      expect(typeof event.data.ubicacion.longitud).toBe('string');
      expect(busCrypto.decryptCoordinate(event.data.ubicacion.latitud, {
        emergencyId: baseEmergency.id,
        field: 'latitud',
      })).toBeCloseTo(-34.5735);
      expect(busCrypto.decryptCoordinate(event.data.ubicacion.longitud, {
        emergencyId: baseEmergency.id,
        field: 'longitud',
      })).toBeCloseTo(-58.4233);
      // Swap de campos / AAD incorrecto no abre.
      expect(() => busCrypto.decryptCoordinate(event.data.ubicacion.latitud, {
        emergencyId: baseEmergency.id,
        field: 'longitud',
      })).toThrow();
    });

    it('sin busCrypto o sin coords → ubicacion.latitud/longitud null', () => {
      const sinCrypto = buildEmergencyCreatedEvent(
        { ...baseEmergency, latitude: -34.5, longitude: -58.4 },
        'e1',
        { busCrypto: null }
      );
      expect(sinCrypto.data.ubicacion.latitud).toBeNull();
      expect(sinCrypto.data.ubicacion.longitud).toBeNull();

      const busCrypto = createBusLocationCrypto({ keys: { '1': BUS_TEST_KEY }, activeKeyId: '1' });
      const sinCoords = buildEmergencyCreatedEvent(baseEmergency, 'e2', { busCrypto });
      expect(sinCoords.data.ubicacion.latitud).toBeNull();
      expect(sinCoords.data.ubicacion.longitud).toBeNull();
    });

    it('mapea severity -> prioridad en espanol uppercase', () => {
      const combos = [
        ['low', 'BAJA'],
        ['medium', 'MEDIA'],
        ['high', 'ALTA'],
        ['critical', 'CRITICA'],
      ];
      for (const [severity, prioridad] of combos) {
        const event = buildEmergencyCreatedEvent({ ...baseEmergency, severity }, 'evt-sev');
        expect(event.data.prioridad).toBe(prioridad);
      }
    });

    it('severity desconocida o ausente -> prioridad null', () => {
      expect(buildEmergencyCreatedEvent({ ...baseEmergency, severity: null }, 'e').data.prioridad).toBeNull();
      expect(buildEmergencyCreatedEvent({ ...baseEmergency, severity: 'exploding' }, 'e').data.prioridad).toBeNull();
    });

    it('correlationId cae a emergenciaId cuando no viene en la emergencia', () => {
      const event = buildEmergencyCreatedEvent({ ...baseEmergency, correlationId: null }, 'evt-cx');
      expect(event.correlationId).toBe(baseEmergency.id);
      expect(event.data.correlationId).toBe(baseEmergency.id);
    });
  });

  describe('buildEmergencyUpdatedEvent - contrato cerrado 2026-11-02 (issue #48)', () => {
    const baseArgs = {
      emergency: {
        id: '5d1e9a7c-3b2f-4f61-9c8e-0a4b7d2e6f13',
        correlationId: 'c-9120',
        severity: 'high',
        assignedOfficerId: 'OFF-123',
        updatedAt: '2026-11-02T23:10:00.000Z',
      },
      history: { previousStatus: 'VALIDATED', newStatus: 'DISPATCHED' },
      actor: 'DISP-Demo001',
      reason: 'Asignado por regla de proximidad',
      eventId: 'evt-upd-1',
    };

    it('renombra el evento: EmergenciaActualizada (no EmergenciaEstadoActualizado)', () => {
      const event = buildEmergencyUpdatedEvent(baseArgs);
      expect(event.type).toBe('EmergenciaActualizada');
    });

    it('traduce estados a espanol y renombra campos', () => {
      const event = buildEmergencyUpdatedEvent(baseArgs);
      expect(event.data.emergenciaId).toBe(baseArgs.emergency.id);
      expect(event.data.estadoAnterior).toBe('VALIDADA');
      expect(event.data.estadoNuevo).toBe('DESPACHADA');
      expect(event.data.usuarioId).toBe('DISP-Demo001');
      expect(event.data.resolucion).toBe(baseArgs.reason);
      expect(event.data.prioridad).toBe('ALTA');
    });

    it('en DESPACHADA publica asignadoA con el oficial', () => {
      const event = buildEmergencyUpdatedEvent(baseArgs);
      expect(event.data.asignadoA).toBe('OFF-123');
    });

    it('fuera de DESPACHADA no expone asignadoA', () => {
      const event = buildEmergencyUpdatedEvent({
        ...baseArgs,
        history: { previousStatus: 'PENDING', newStatus: 'VALIDATED' },
      });
      expect(event.data.asignadoA).toBeNull();
    });

    it('resueltoAt solo se setea cuando estadoNuevo = RESUELTA', () => {
      const resuelto = buildEmergencyUpdatedEvent({
        ...baseArgs,
        history: { previousStatus: 'ON_SCENE', newStatus: 'RESOLVED' },
      });
      expect(resuelto.data.resueltoAt).toBeTruthy();

      const noResuelto = buildEmergencyUpdatedEvent({
        ...baseArgs,
        history: { previousStatus: 'PENDING', newStatus: 'VALIDATED' },
      });
      expect(noResuelto.data.resueltoAt).toBeNull();
    });

    it('no publica los nombres viejos', () => {
      const event = buildEmergencyUpdatedEvent(baseArgs);
      expect(event.data.id).toBeUndefined();
      expect(event.data.previousStatus).toBeUndefined();
      expect(event.data.newStatus).toBeUndefined();
      expect(event.data.actor).toBeUndefined();
      expect(event.data.reason).toBeUndefined();
      expect(event.data.timestamp).toBeUndefined();
    });
  });

  describe('buildEmergencyPrioritizedEvent', () => {
    it('con correlationId presente en el input, lo usa tal cual en el evento y en data', () => {
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
        eventId: 'evt-1',
      });

      expect(event).toEqual({
        type: 'EmergenciaPriorizada',
        eventId: 'evt-1',
        correlationId: 'corr-1',
        data: {
          id: 'em-1',
          correlationId: 'corr-1',
          incidentId: 'inc-1',
          priorityIndividual: 'low',
          incidentPriority: 'high',
          priority: 'high',
          score: 62,
          reasonCodes: ['PROXIMITY_CLUSTER'],
          algorithmVersion: 'rule-based-v1',
        },
      });
    });

    it('sin correlationId, cae en emergencyId tanto en el nivel del evento como en data', () => {
      const event = buildEmergencyPrioritizedEvent({
        emergencyId: 'em-2',
        correlationId: undefined,
        incidentId: 'inc-2',
        priorityIndividual: 'high',
        incidentPriority: 'high',
        priority: 'high',
        score: 30,
        reasonCodes: [],
        algorithmVersion: 'rule-based-v1',
        eventId: 'evt-2',
      });

      expect(event.correlationId).toBe('em-2');
      expect(event.data.correlationId).toBe('em-2');
      expect(event.data.id).toBe('em-2');
    });
  });
});
