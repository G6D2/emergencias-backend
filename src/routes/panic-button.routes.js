const express = require('express');
const { PanicButtonController } = require('../controllers/panic-button.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireCitizen, requireCitizenOrDispatcher } = require('../auth/authorize');
const {
  createPanicButtonRateLimiter,
  createPanicButtonIpRateLimiter,
} = require('../security/rate-limit');

function createPanicButtonRoutes(kafkaService, emergencyRepository, authenticate) {
  const router = express.Router();
  const controller = new PanicButtonController(kafkaService, emergencyRepository);

  /**
   * @openapi
   * /api/panic-button:
   *   post:
   *     tags: [Panic Button]
   *     summary: Activa el botón de pánico
   *     description: |
   *       Requiere grupo `citizen`. El userId se toma del JWT (claim `sub`).
   *       Persiste una emergency en status PENDING y publica el evento en Kafka.
   *     security:
   *       - bearerAuth: []
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
   *       401:
   *         description: Token ausente o inválido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Grupo insuficiente (requiere citizen)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       429:
   *         description: Demasiadas activaciones desde la misma IP (rate limit)
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
  router.post(
    '/',
    createPanicButtonIpRateLimiter(),
    authenticate,
    requireCitizen,
    createPanicButtonRateLimiter(),
    asyncHandler(async (req, res) => {
      const result = await controller.triggerPanicButton(req.body, req.user);
      res.status(201).json(result);
    })
  );

  /**
   * @openapi
   * /api/panic-button/{id}:
   *   get:
   *     tags: [Panic Button]
   *     summary: Obtiene un evento de botón de pánico
   *     description: |
   *       Requiere `citizen` (solo propias) o `dispatcher` (todas).
   *       Delega en el mismo método que GET /api/emergencies/{id}: una
   *       emergencia ajena responde **404** y no 403, para no revelar que el
   *       id existe.
   *     security:
   *       - bearerAuth: []
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
   *                   $ref: '#/components/schemas/EmergencyDetail'
   *       400:
   *         description: El id no tiene formato UUID
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       401:
   *         description: Token ausente o inválido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Emergencia inexistente, o ajena para un citizen
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  // Se mantiene por compatibilidad con clientes existentes: devuelve la
  // emergencia sola. El detalle completo (historial de estados, observaciones,
  // refuerzos) vive en GET /api/emergencies/:id (tarea #32).
  router.get('/:id', authenticate, requireCitizenOrDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.getPanicButtonEvent(req.params.id, req.user);
    res.json(result);
  }));

  return router;
}

module.exports = { createPanicButtonRoutes };
