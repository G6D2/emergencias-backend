const express = require('express');
const { requireDispatcher } = require('../auth/authorize');
const { UnauthorizedError } = require('../errors/app-errors');
const { AnaliticaEmbedClient } = require('../services/analitica-embed');
const { asyncHandler } = require('../utils/async-handler');

function readBearer(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme !== 'Bearer' || !token || rest.length > 0) return null;
  return token;
}

function createAnaliticaRoutes(authenticate, client) {
  const router = express.Router();
  const embed = client || new AnaliticaEmbedClient();

  /**
   * @openapi
   * /admin/analitica:
   *   get:
   *     tags: [Analitica]
   *     summary: Tablero de Analítica embebido
   *     description: >
   *       Proxy del HTML de Analítica (`GET /embed/emergencias`). Exige el access
   *       token human del dispatcher y lo reenvía como Bearer. La respuesta es el
   *       HTML de Analítica, sin modificar y sin cache. El iframe del frontend
   *       tiene que apuntar a una ruta del mismo origen que adjunte este Bearer
   *       (la cookie de sesión); el token no va en la URL.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: HTML del tablero
   *         content:
   *           text/html:
   *             schema:
   *               type: string
   *       401:
   *         description: Token ausente o inválido (propio o el que devolvió Analítica)
   *       403:
   *         description: El usuario no es dispatcher, o Analítica rechazó el namespace
   *       503:
   *         description: Analítica no disponible
   */
  router.get('/', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const token = readBearer(req);
    if (!token) {
      throw new UnauthorizedError('Falta el header Authorization');
    }

    const result = await embed.fetchDashboard(token);

    // El middleware global manda X-Frame-Options: DENY. Este HTML tiene que
    // poder verse en el iframe del frontend; el resto de las cabeceras de
    // Analítica pisa las nuestras cuando vienen.
    res.removeHeader('X-Frame-Options');
    for (const [name, value] of Object.entries(result.headers)) {
      res.setHeader(name, value);
    }
    if (!result.headers['content-type']) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
    if (!result.headers['cache-control']) {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.status(result.status).send(result.body);
  }));

  return router;
}

module.exports = { createAnaliticaRoutes };
