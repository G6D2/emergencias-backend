const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const { requireDispatcher } = require('../auth/authorize');

function createOutboxRoutes(emergencyRepository, authenticate) {
  const router = express.Router();

  /**
   * @openapi
   * /api/outbox-events:
   *   get:
   *     tags: [Outbox]
   *     summary: Consulta el estado operativo de eventos outbox
   *     description: Requiere grupo dispatcher. No devuelve payloads para evitar exponer datos sensibles.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
  *           enum: [PENDING, PROCESSING, PUBLISHED, FAILED]
   *       - in: query
   *         name: topic
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
   *           maximum: 100
   *     responses:
   *       200:
   *         description: Estado de eventos outbox
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.get('/', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const result = await emergencyRepository.findOutboxPage({
      status: req.query.status,
      topic: req.query.topic,
      page,
      limit,
    });

    res.json({
      data: result.events,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    });
  }));

  return router;
}

module.exports = { createOutboxRoutes };