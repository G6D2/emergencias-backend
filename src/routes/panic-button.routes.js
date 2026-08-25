const express = require('express');
const { PanicButtonController } = require('../controllers/panic-button.controller');

function createPanicButtonRoutes(kafkaService) {
  const router = express.Router();
  const controller = new PanicButtonController(kafkaService);

  // POST /api/panic-button - Trigger panic button
  router.post('/', async (req, res, next) => {
    try {
      const result = await controller.triggerPanicButton(req.body);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/panic-button/:id - Get panic button event details
  router.get('/:id', async (req, res, next) => {
    try {
      const result = await controller.getPanicButtonEvent(req.params.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createPanicButtonRoutes };
