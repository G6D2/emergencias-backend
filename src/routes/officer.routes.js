const express = require('express');
const { OfficerController } = require('../controllers/officer.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireDispatcher } = require('../auth/authorize');

function createOfficerRoutes(officerRepository, authenticate) {
  const router = express.Router();
  const controller = new OfficerController(officerRepository);

  /**
   * @openapi
   * /api/officers:
   *   get:
   *     tags: [Officers]
   *     summary: Lista oficiales del catálogo
   *     description: |
   *       Requiere grupo `dispatcher`. Catálogo local para asignar a emergencias;
   *       los oficiales no se autentican en este módulo.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [disponible, ocupado]
   *     responses:
   *       200:
   *         description: Listado de oficiales
   *       400:
   *         description: Filtro status fuera del catálogo (disponible, ocupado)
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.get('/', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.listOfficers(req.query);
    res.json(result);
  }));

  return router;
}

module.exports = { createOfficerRoutes };
