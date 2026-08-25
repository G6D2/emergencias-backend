const express = require('express');
const router = express.Router();
const { PanicButtonController } = require('../controllers/panic-button.controller');

const controller = new PanicButtonController();

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

module.exports = { panicButtonRoutes: router };
