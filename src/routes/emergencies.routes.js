const express = require('express');
const { EmergencyController } = require('../controllers/emergency.controller');
const { asyncHandler } = require('../utils/async-handler');

function createEmergenciesRoutes(kafkaService, emergencyRepository) {
  const router = express.Router();
  const controller = new EmergencyController(kafkaService, emergencyRepository);

  /**
   * @openapi
   * /api/emergencies:
   *   get:
   *     tags: [Emergencies]
   *     summary: Lista emergencias paginadas
   *     description: Soporta filtros por status, severity, rango de fechas, oficial asignado y tipo de emergencia.
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
   */
  router.get('/', asyncHandler(async (req, res) => {
    const result = await controller.listEmergencies(req.query);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/cancel:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Cancela una emergencia
   *     description: Solo si el status actual es PENDING o VALIDATED. Publica EmergencyStatusUpdated en Kafka.
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
  // PATCH /api/emergencies/:id/cancel - el ciudadano cancela su emergency
  router.patch('/:id/cancel', asyncHandler(async (req, res) => {
    const { actor, reason } = req.body || {};
    const result = await controller.cancelEmergency(req.params.id, { actor, reason });
    res.json(result);
  }));

  return router;
}

module.exports = { createEmergenciesRoutes };
