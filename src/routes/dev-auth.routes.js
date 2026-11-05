const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const {
  createDevLoginRateLimiter,
  createAuthLoginRateLimiter,
  createAuthRegisterRateLimiter,
} = require('../security/rate-limit');
const { AuthController } = require('../controllers/auth.controller');
const { resolveDevLoginClaims } = require('../auth/dev-login-policy');

/**
 * Rutas de auth local (AUTH_MODE=local).
 * - /auth/dev/login: emite JWT inventando sub (tests / atajos).
 * - /auth/register + /auth/login: usuarios reales en auth_users.
 */
function createDevAuthRoutes(tokenIssuer, authUserRepository = null) {
  const router = express.Router();
  const authController = authUserRepository
    ? new AuthController(authUserRepository, tokenIssuer)
    : null;

  /**
   * @openapi
   * /auth/dev/login:
   *   post:
   *     tags: [Dev Auth]
   *     summary: "[Solo AUTH_MODE=local] Obtener access token de desarrollo"
   *     description: |
   *       Emite un JWT con la misma forma que CityPass+ para probar la API sin IdP.
   *       En production (ALLOW_LOCAL_AUTH) solo acepta sujetos de la allowlist demo.
   *       No disponible con AUTH_MODE=idp.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/DevLoginRequest'
   *     responses:
   *       200:
   *         description: Token emitido (mismo shape que POST /auth/login del IdP)
   *       400:
   *         description: Datos inválidos
   *       429:
   *         description: Rate limit
   */
  router.post('/dev/login', createDevLoginRateLimiter(), asyncHandler(async (req, res) => {
    const claims = resolveDevLoginClaims(req.body || {}, process.env);
    const tokens = await tokenIssuer.issueAccessToken(claims);
    res.json(tokens);
  }));

  if (authController) {
    /**
     * @openapi
     * /auth/register:
     *   post:
     *     tags: [Dev Auth]
     *     summary: "[AUTH_MODE=local] Registro email+password"
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [email, password]
     *             properties:
     *               email: { type: string, format: email }
     *               password: { type: string, minLength: 8 }
     *               preferred_username: { type: string }
     *     responses:
     *       201:
     *         description: Usuario creado + access_token
     *       409:
     *         description: Email ya registrado
     *       429:
     *         description: Rate limit (por IP)
     */
    router.post('/register', createAuthRegisterRateLimiter(), asyncHandler(async (req, res) => {
      const result = await authController.register(req.body);
      res.status(201).json(result);
    }));

    /**
     * @openapi
     * /auth/login:
     *   post:
     *     tags: [Dev Auth]
     *     summary: "[AUTH_MODE=local] Login email+password"
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [email, password]
     *             properties:
     *               email: { type: string, format: email }
     *               password: { type: string }
     *     responses:
     *       200:
     *         description: access_token + user
     *       401:
     *         description: Credenciales inválidas
     *       429:
     *         description: Rate limit (intentos fallidos por IP)
     */
    router.post('/login', createAuthLoginRateLimiter(), asyncHandler(async (req, res) => {
      const result = await authController.login(req.body);
      res.json(result);
    }));
  }

  return router;
}

module.exports = { createDevAuthRoutes };
