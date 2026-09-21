const { buildEmergencyPrioritizedEvent } = require('../services/emergency-events');

describe('emergency-events', () => {
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
