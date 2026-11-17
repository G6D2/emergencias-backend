const express = require('express');
const { ContextoZonaController } = require('../controllers/contexto-zona.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireDispatcher } = require('../auth/authorize');

function createContextosZonaRoutes(contextoZonaRepository, authenticate) {
  const router = express.Router();
  const controller = new ContextoZonaController(contextoZonaRepository);

  /**
   * @openapi
   * /api/contextos-zona/activos:
   *   get:
   *     tags: [ContextosZona]
   *     summary: Alertas climáticas activas o por empezar
   *     description: |
   *       Requiere grupo `dispatcher`. Alimenta el banner de alertas climáticas
   *       del tablero. Solo lee los contextos de zona `ALERTA_CLIMATICA` que
   *       crea el listener de `CriticidadClimaticaConfirmada` (ADR "Responder a
   *       las alertas climáticas de Espacios"): no publica eventos ni cambia
   *       prioridades.
   *
   *       Devuelve una entrada por alerta (no por punto), con contextos no
   *       dados de baja y sin vencer, incluidas las que todavía no empezaron
   *       (`enCurso: false`). Solo `ALTA` y `CRITICA` generan contextos, así que
   *       `MEDIA` y `BAJA` no aparecen. Una alerta finalizada deja de aparecer.
   *       Orden: primero las `CRITICA`, después por `vigenteDesde`. Sin alertas,
   *       `data` es `[]`.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Alertas climáticas activas
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/AlertaClimaticaActiva'
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.get('/activos', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.listActivos();
    res.json(result);
  }));

  return router;
}

module.exports = { createContextosZonaRoutes };
