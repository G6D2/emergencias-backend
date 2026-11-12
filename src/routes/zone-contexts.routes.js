const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const { requireDispatcher } = require('../auth/authorize');
const { estadoDelContexto } = require('../domain/contexto-zona');

const limitOf = (query) => Math.min(Math.max(Number.parseInt(query.limit, 10) || 50, 1), 100);

// Lecturas para ver qué eventos externos llegaron y qué contextos de zona
// dejaron. Solo lectura y solo dispatcher. Las usa el banco de pruebas
// (casos.sh) para mirar un entorno desplegado sin acceso a su base.
function createZoneContextsRoutes(contextoZonaRepository, authenticate) {
  const router = express.Router();

  /**
   * @openapi
   * /api/zone-contexts:
   *   get:
   *     tags: [ZoneContexts]
   *     summary: Lista los contextos de zona (eventos que elevan la prioridad cercana)
   *     description: |
   *       Requiere grupo `dispatcher`. Más recientes primero. Cada contexto trae su punto,
   *       radio, ventana, `estado` calculado al momento del pedido (`EN_CURSO`, `PROGRAMADO`,
   *       `SUSPENDIDO`, `FINALIZADO`, `DADO_DE_BAJA` o `SIN_PUNTO`) y `emergenciasVinculadas`:
   *       cuántas emergencias se crearon dentro del radio con el contexto en curso.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 50
   *           maximum: 100
   *     responses:
   *       200:
   *         description: Contextos de zona
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.get('/', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const ahora = new Date();
    const contextos = await contextoZonaRepository.findRecent({ limit: limitOf(req.query) });
    res.json({ data: contextos.map((contexto) => ({ ...contexto, estado: estadoDelContexto(contexto, ahora) })) });
  }));

  return router;
}

function createReceivedEventsRoutes(eventosProcesadosRepository, authenticate) {
  const router = express.Router();

  /**
   * @openapi
   * /api/received-events:
   *   get:
   *     tags: [ZoneContexts]
   *     summary: Lista los eventos externos recibidos del bus
   *     description: |
   *       Requiere grupo `dispatcher`. Más recientes primero. Dice si cada evento se procesó
   *       (`PROCESSED`) o se descartó (`DISCARDED`, con `discardReason`). `contextoReferencia`
   *       es el `eventoId` del contexto de zona si ese mensaje fue el último que lo escribió.
   *       No devuelve el contenido del evento.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 50
   *           maximum: 100
   *     responses:
   *       200:
   *         description: Eventos recibidos
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.get('/', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    res.json({ data: await eventosProcesadosRepository.findRecent({ limit: limitOf(req.query) }) });
  }));

  return router;
}

module.exports = { createZoneContextsRoutes, createReceivedEventsRoutes };
