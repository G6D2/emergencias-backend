const express = require('express');
const { EmergencyController } = require('../controllers/emergency.controller');

function createEmergenciesRoutes(kafkaService, emergencyRepository) {
  const router = express.Router();
  const controller = new EmergencyController(kafkaService, emergencyRepository);

  router.get('/', async (req, res, next) => {
    try {
      const result = await controller.listEmergencies(req.query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // PATCH /emergencies/:id/cancel - cancelación solicitada por el ciudadano
  router.patch('/:id/cancel', async (req, res, next) => {
    try {
      const { actor, reason } = req.body || {};
      const result = await controller.cancelEmergency(req.params.id, { actor, reason });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createEmergenciesRoutes };
