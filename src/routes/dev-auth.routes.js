const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const { createDevLoginRateLimiter } = require('../security/rate-limit');

function createDevAuthRoutes(tokenIssuer) {
  const router = express.Router();

  /**
   * @openapi
   * /auth/dev/login:
   *   post:
   *     tags: [Dev Auth]
   *     summary: "[Solo AUTH_MODE=local] Obtener access token de desarrollo"
   *     description: |
   *       Emite un JWT con la misma forma que CityPass+ para probar la API sin IdP.
   *       No disponible en producción ni con AUTH_MODE=idp.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/DevLoginRequest'
   *     responses:
   *       200:
   *         description: Token emitido (mismo shape que POST /auth/login del IdP)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DevLoginResponse'
   *       400:
   *         description: Datos inválidos
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       429:
   *         description: Demasiados intentos desde la misma IP (rate limit, 10 req/min)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.post('/login', createDevLoginRateLimiter(), asyncHandler(async (req, res) => {
    const { sub, preferred_username: preferredUsername, groups } = req.body || {};
    const tokens = await tokenIssuer.issueAccessToken({
      sub,
      preferred_username: preferredUsername,
      groups,
    });
    res.json(tokens);
  }));

  return router;
}

module.exports = { createDevAuthRoutes };
