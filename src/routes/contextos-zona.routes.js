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
   *     summary: Contextos de zona activos o por empezar
   *     description: |
   *       Requiere grupo `dispatcher`. Alimenta el banner de alertas
   *       climáticas del tablero. Devuelve los contextos no dados de baja, no
   *       suspendidos y sin vencer, incluidos los que todavía no empezaron.
   *       Incluye las alertas que no elevan prioridad (gravedad LEVE o MEDIA,
   *       `eleva: false`). No expone punto ni radio de los eventos comunitarios.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: tipo
   *         schema:
   *           type: string
   *           enum: [ALERTA_CLIMATICA, EVENTO_ESPACIO_PUBLICO]
   *         description: Sin tipo devuelve todos.
   *     responses:
   *       200:
   *         description: Contextos activos, del que empieza antes al que empieza después
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       referenciaExterna: { type: string, description: 'alertaId o eventoId de Espacios' }
   *                       tipo: { type: string, enum: [ALERTA_CLIMATICA, EVENTO_ESPACIO_PUBLICO] }
   *                       fenomeno: { type: string, nullable: true, example: TORMENTA_ELECTRICA }
   *                       gravedad: { type: string, nullable: true, enum: [LEVE, MEDIA, ALTA, EXTREMA] }
   *                       eleva: { type: boolean, description: 'false si no sube la prioridad de ningún tipo' }
   *                       tiposEmergencia:
   *                         type: array
   *                         nullable: true
   *                         items: { type: string }
   *                         description: 'Tipos que eleva. null = todos'
   *                       barrios:
   *                         type: array
   *                         nullable: true
   *                         items: { type: string }
   *                       descripcion: { type: string, nullable: true }
   *                       vigenteDesde: { type: string, format: date-time }
   *                       vigenteHasta: { type: string, format: date-time }
   *       400:
   *         description: tipo inválido
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.get('/activos', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.listActivos(req.query);
    res.json(result);
  }));

  return router;
}

module.exports = { createContextosZonaRoutes };
