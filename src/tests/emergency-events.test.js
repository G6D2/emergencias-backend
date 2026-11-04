const {
  buildEmergencyCreatedEvent,
  buildEmergencyUpdatedEvent,
  buildEmergencyPrioritizedEvent,
} = require('../services/emergency-events');

describe('emergency-events', () => {
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
      // Null hasta #76 (barrio) y hasta que Juani/Valen cierren la regla de lat/lng.
      expect(event.data.ubicacion.barrio).toBeNull();
      expect(event.data.latitud).toBeNull();
      expect(event.data.longitud).toBeNull();
      // Null hasta que se consuman eventos de otros modulos (#77/#79/#80).
      expect(event.data.causaId).toBeNull();
      expect(event.data.causaTipo).toBeNull();
      expect(event.data.prioridadOriginal).toBeNull();
      // False por default hasta que #76/#85 pongan la logica real.
      expect(event.data.afectaCirculacion).toBe(false);
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
