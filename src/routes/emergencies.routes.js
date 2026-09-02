const express = require('express');
const { EmergencyController } = require('../controllers/emergency.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireCitizen, requireDispatcher } = require('../auth/authorize');

function createEmergenciesRoutes(kafkaService, emergencyRepository, authenticate) {
  const router = express.Router();
  const controller = new EmergencyController(kafkaService, emergencyRepository);

  /**
   * @openapi
   * /api/emergencies:
   *   get:
   *     tags: [Emergencies]
   *     summary: Lista emergencias paginadas
   *     description: |
   *       Requiere grupo `dispatcher`. Soporta filtros por status, severity, rango de fechas, oficial asignado y tipo de emergencia.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *         description: Lista de statuses separados por coma (ej. PENDING,VALIDATED)
   *       - in: query
   *         name: severity
   *         schema:
   *           type: string
   *       - in: query
   *         name: from
   *         schema:
   *           type: string
   *           format: date-time
   *       - in: query
   *         name: to
   *         schema:
   *           type: string
   *           format: date-time
   *       - in: query
   *         name: assignedOfficerId
   *         schema:
   *           type: string
   *       - in: query
   *         name: type
   *         schema:
   *           type: string
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: sortBy
   *         schema:
   *           type: string
   *           enum: [createdAt, priority]
   *       - in: query
   *         name: order
   *         schema:
   *           type: string
   *           enum: [asc, desc]
   *     responses:
   *       200:
   *         description: Página de emergencias
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Grupo insuficiente
   */
  router.get('/', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.listEmergencies(req.query);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/cancel:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Cancela una emergencia
   *     description: |
   *       Requiere grupo `citizen` y ser dueño de la emergencia. Solo si el status actual es PENDING o VALIDATED.
   *       El actor se toma del JWT (claim `sub`). Publica EmergencyStatusUpdated en Kafka.
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
