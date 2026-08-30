const express = require('express');
const { UserController } = require('../controllers/user.controller');
const { asyncHandler } = require('../utils/async-handler');

function createUserRoutes(authenticate) {
  const router = express.Router();
  const controller = new UserController();

  /**
   * @openapi
   * /api/user:
   *   get:
   *     tags: [User]
   *     summary: Perfil del usuario autenticado
   *     description: Devuelve identidad y groups del JWT (sin confiar en datos del cliente).
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Usuario autenticado
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CurrentUserResponse'
   *       401:
   *         description: Token ausente o inválido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.get('/', authenticate, asyncHandler(async (req, res) => {
    const result = controller.getCurrentUser(req.user);
    res.json(result);
  }));

  return router;
}

module.exports = { createUserRoutes };
