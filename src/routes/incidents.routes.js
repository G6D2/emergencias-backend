const express = require('express');
const { IncidentController } = require('../controllers/incident.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireDispatcher } = require('../auth/authorize');

function createIncidentsRoutes(incidentRepository, authenticate) {
  const router = express.Router();
  const controller = new IncidentController(incidentRepository);

  /**
   * @openapi
   * /api/incidents:
   *   get:
   *     tags: [Incidents]
   *     summary: Lista paginada de incidentes activos
   *     description: |
   *       Requiere grupo `dispatcher`. Un incidente agrupa varias emergencias del mismo tipo,
   *       cercanas entre sí (Risk Engine + RuleBasedGrouper, corre cada 60s). "Activo" significa
   *       que tiene al menos una emergencia miembro que no está en status terminal
   *       (CLOSED, CANCELLED, DISCARDED).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Página de incidentes activos
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Incident'
   *                 pagination:
   *                   $ref: '#/components/schemas/Pagination'
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.get('/', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.listIncidents(req.query);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/incidents/{id}:
   *   get:
   *     tags: [Incidents]
   *     summary: Detalle de un incidente con sus emergencias miembro
   *     description: |
   *       Requiere grupo `dispatcher`. Las emergencias miembro vienen sin coordenadas
   *       (id, status, emergencyType, createdAt): es un resumen operativo, no un
   *       reemplazo del detalle de cada emergencia.
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
   *         description: Detalle del incidente
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 data:
   *                   $ref: '#/components/schemas/IncidentDetail'
   *       400:
   *         description: El id no tiene formato UUID
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   *       404:
   *         description: Incidente inexistente
   */
  router.get('/:id', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.getIncidentDetail(req.params.id);
    res.json(result);
  }));

  return router;
}

module.exports = { createIncidentsRoutes };
