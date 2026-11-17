const express = require('express');
const { PanicButtonController } = require('../controllers/panic-button.controller');
const { asyncHandler } = require('../utils/async-handler');
const { parseIdempotencyKey } = require('../utils/idempotency-key');
const { requireCitizen, requireCitizenOrDispatcher } = require('../auth/authorize');
const {
  createPanicButtonRateLimiter,
  createPanicButtonIpRateLimiter,
} = require('../security/rate-limit');

function createPanicButtonRoutes(emergencyRepository, authenticate) {
  const router = express.Router();
  const controller = new PanicButtonController(emergencyRepository);

  /**
   * @openapi
   * /api/panic-button:
   *   post:
   *     tags: [Panic Button]
   *     summary: Activa el botón de pánico
   *     description: |
   *       Requiere grupo `citizen`. El userId se toma del JWT (claim `sub`).
   *       Persiste una emergency en status PENDING y publica el evento en Kafka.
   *
   *       **Idempotency-Key (opcional):** con la misma clave y el mismo usuario,
   *       un reintento dentro de las 24 h no crea otra emergencia ni otro
   *       evento: devuelve la emergencia del primer pedido con el mismo status
   *       (201) y el header `Idempotent-Replayed: true`. Dos pedidos
   *       simultáneos con la misma clave crean una sola emergencia. La clave es
   *       por usuario: la misma clave de otro usuario es otra alta. Sin clave,
   *       cada pedido crea una emergencia.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: header
   *         name: Idempotency-Key
   *         required: false
   *         description: |
   *           Identifica el pedido lógico; se repite igual en cada reintento
   *           (el BFF manda un UUID v4). De 1 a 128 caracteres entre letras,
   *           números y `_ . : -`; también se acepta entre comillas dobles.
   *           Vacío equivale a no mandarla. Mal formada → 400.
   *         schema:
   *           type: string
   *           maxLength: 128
   *           pattern: '^[A-Za-z0-9_.:-]+$'
   *           example: 8e03978e-40d5-43e8-bc93-6894a57f9324
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PanicButtonRequest'
   *     responses:
   *       201:
   *         description: Emergencia creada, o la ya creada si es un reintento con la misma Idempotency-Key
   *         headers:
   *           Idempotent-Replayed:
   *             description: Solo en un reintento con Idempotency-Key ya usada; la emergencia no se creó ahora.
   *             schema:
   *               type: string
   *               enum: ['true']
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PanicButtonResponse'
   *       400:
   *         description: Faltan campos requeridos o la Idempotency-Key está mal formada
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
   *       409:
   *         description: La Idempotency-Key quedó en uso por otro pedido que no terminó; se puede reintentar
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
      const idempotencyKey = parseIdempotencyKey(req.get('Idempotency-Key'));
      const result = await controller.triggerPanicButton(req.body, req.user, { idempotencyKey });
      if (result.replayed) res.set('Idempotent-Replayed', 'true');
      res.status(result.statusCode).json(result.body);
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
