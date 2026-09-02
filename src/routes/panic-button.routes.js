const express = require('express');
const { PanicButtonController } = require('../controllers/panic-button.controller');
const { asyncHandler } = require('../utils/async-handler');

function createPanicButtonRoutes(kafkaService, emergencyRepository) {
  const router = express.Router();
  const controller = new PanicButtonController(kafkaService, emergencyRepository);

  /**
   * @openapi
   * /api/panic-button:
   *   post:
   *     tags: [Panic Button]
   *     summary: Activa el botón de pánico
   *     description: Persiste una emergency en status PENDING y publica el evento en Kafka.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PanicButtonRequest'
   *     responses:
   *       201:
   *         description: Emergencia creada
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PanicButtonResponse'
   *       400:
   *         description: Faltan campos requeridos
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       503:
   *         description: Kafka no disponible
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  // POST /api/panic-button - dispara el botón de pánico
  router.post('/', asyncHandler(async (req, res) => {
    const result = await controller.triggerPanicButton(req.body);
    res.status(201).json(result);
  }));

  /**
   * @openapi
   * /api/panic-button/{id}:
   *   get:
   *     tags: [Panic Button]
   *     summary: Obtiene un evento de botón de pánico
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       200:
   *         description: Emergencia encontrada
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/Emergency'
   *       404:
   *         description: Emergencia no encontrada
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  // GET /api/panic-button/:id - detalle de un evento de pánico
  router.get('/:id', asyncHandler(async (req, res) => {
    const result = await controller.getPanicButtonEvent(req.params.id);
    res.json(result);
  }));

  return router;
}

module.exports = { createPanicButtonRoutes };
