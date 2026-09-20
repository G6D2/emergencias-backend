const { IncidentController } = require('../controllers/incident.controller');
const { NotFoundError, ValidationError } = require('../errors/app-errors');

describe('IncidentController', () => {
  describe('listIncidents', () => {
    it('normaliza page/limit con defaults y topes (1..100)', async () => {
      const incidentRepository = {
        findActivePage: jest.fn().mockResolvedValue({ incidents: [], total: 0 }),
      };
      const controller = new IncidentController(incidentRepository);

      await controller.listIncidents({});

      expect(incidentRepository.findActivePage).toHaveBeenCalledWith({ page: 1, limit: 20 });
    });

    it('acepta page/limit del query dentro de los límites', async () => {
      const incidentRepository = {
        findActivePage: jest.fn().mockResolvedValue({ incidents: [{ id: 'i-1' }], total: 1 }),
      };
      const controller = new IncidentController(incidentRepository);

      const result = await controller.listIncidents({ page: '2', limit: '5' });

      expect(incidentRepository.findActivePage).toHaveBeenCalledWith({ page: 2, limit: 5 });
      expect(result).toEqual({
        data: [{ id: 'i-1' }],
        pagination: { page: 2, limit: 5, total: 1, totalPages: 1 },
      });
    });

    it('limita page a >= 1 y limit a <= 100', async () => {
      const incidentRepository = {
        findActivePage: jest.fn().mockResolvedValue({ incidents: [], total: 0 }),
      };
      const controller = new IncidentController(incidentRepository);

      await controller.listIncidents({ page: '-5', limit: '9999' });

      expect(incidentRepository.findActivePage).toHaveBeenCalledWith({ page: 1, limit: 100 });
    });
  });

  describe('getIncidentDetail', () => {
    it('lanza ValidationError si el id no es un UUID válido', async () => {
      const controller = new IncidentController({ findByIdWithMembers: jest.fn() });

      await expect(controller.getIncidentDetail('not-a-uuid')).rejects.toThrow(ValidationError);
    });

    it('lanza NotFoundError si el incidente no existe', async () => {
      const incidentRepository = { findByIdWithMembers: jest.fn().mockResolvedValue(null) };
      const controller = new IncidentController(incidentRepository);

      await expect(controller.getIncidentDetail('550e8400-e29b-41d4-a716-446655440000'))
        .rejects.toThrow(NotFoundError);
    });

    it('devuelve success + data cuando el incidente existe', async () => {
      const incident = { id: '550e8400-e29b-41d4-a716-446655440000', members: [] };
      const incidentRepository = { findByIdWithMembers: jest.fn().mockResolvedValue(incident) };
      const controller = new IncidentController(incidentRepository);

      const result = await controller.getIncidentDetail(incident.id);

      expect(result).toEqual({ success: true, data: incident });
    });
  });
});
