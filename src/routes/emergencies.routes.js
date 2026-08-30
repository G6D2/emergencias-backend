const express = require('express');
const { EmergencyController } = require('../controllers/emergency.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireCitizen, requireCitizenOrDispatcher } = require('../auth/authorize');

function createEmergenciesRoutes(kafkaService, emergencyRepository, authenticate) {
  const router = express.Router();
  const controller = new EmergencyController(kafkaService, emergencyRepository);

  /**
   * @openapi
   * /api/emergencies:
   *   get:
   *     tags: [Emergencies]
   *     summary: Lista emergencias visibles
   *     description: |
   *       Requiere `citizen` o `dispatcher`.
   *       Dispatcher ve todas; citizen solo las propias (`userId === sub`).
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Lista de emergencias
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Emergency'
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Grupo insuficiente
   */
  router.get('/', authenticate, requireCitizenOrDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.listEmergencies(req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/cancel:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Cancela una emergencia
   *     description: Requiere grupo `citizen`. Solo la propia emergencia en status CREATED. El actor se toma del JWT (claim sub).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CancelEmergencyRequest'
   *     responses:
   *       200:
   *         description: Emergencia cancelada
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/Emergency'
   *       401:
   *         description: Token ausente o inválido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: No es el dueño o grupo insuficiente
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Emergencia no encontrada
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       409:
   *         description: Estado no cancelable
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
  router.patch('/:id/cancel', authenticate, requireCitizen, asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    const result = await controller.cancelEmergency(req.params.id, { reason }, req.user);
    res.json(result);
  }));

  return router;
}

module.exports = { createEmergenciesRoutes };
