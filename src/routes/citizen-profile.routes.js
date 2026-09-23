const express = require('express');
const { CitizenProfileController } = require('../controllers/citizen-profile.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireCitizen } = require('../auth/authorize');
const { createCitizenProfileMutationRateLimiter } = require('../security/rate-limit');

function createCitizenProfileRoutes(citizenProfileRepository, authenticate) {
  const router = express.Router();
  const controller = new CitizenProfileController(citizenProfileRepository);
  const mutationLimiter = createCitizenProfileMutationRateLimiter();

  /**
   * @openapi
   * /api/citizen/profile:
   *   get:
   *     tags: [CitizenProfile]
   *     summary: Perfil personal del ciudadano autenticado
   *     description: |
   *       Requiere grupo `citizen`. Los campos sensibles (teléfono, contacto
   *       de emergencia, condición médica) se almacenan cifrados en reposo.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Perfil (vacío si aún no se guardó)
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo citizen
   *   put:
   *     tags: [CitizenProfile]
   *     summary: Crea o actualiza el perfil personal del ciudadano
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name: { type: string }
   *               phone: { type: string }
   *               emergencyContactName: { type: string }
   *               emergencyContactPhone: { type: string }
   *               medicalCondition: { type: string, maxLength: 140 }
   *     responses:
   *       200:
   *         description: Perfil actualizado
   *       400:
   *         description: Body inválido
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo citizen
   */
  router.get('/profile', authenticate, requireCitizen, asyncHandler(async (req, res) => {
    res.json(await controller.getProfile(req.user));
  }));

  router.put('/profile', authenticate, requireCitizen, mutationLimiter, asyncHandler(async (req, res) => {
    res.json(await controller.upsertProfile(req.user, req.body));
  }));

  /**
   * @openapi
   * /api/citizen/saved-locations:
   *   get:
   *     tags: [CitizenProfile]
   *     summary: Lista ubicaciones frecuentes del ciudadano
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Listado
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo citizen
   *   post:
   *     tags: [CitizenProfile]
   *     summary: Agrega una ubicación frecuente
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [label, address]
   *             properties:
   *               label: { type: string }
   *               address: { type: string }
   *               lat: { type: number, nullable: true }
   *               lng: { type: number, nullable: true }
   *     responses:
   *       201:
   *         description: Ubicación creada
   *       400:
   *         description: Validación
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo citizen
   */
  router.get('/saved-locations', authenticate, requireCitizen, asyncHandler(async (req, res) => {
    res.json(await controller.listSavedLocations(req.user));
  }));

  router.post('/saved-locations', authenticate, requireCitizen, mutationLimiter, asyncHandler(async (req, res) => {
    const result = await controller.addSavedLocation(req.user, req.body);
    res.status(201).json(result);
  }));

  /**
   * @openapi
   * /api/citizen/saved-locations/{id}:
   *   patch:
   *     tags: [CitizenProfile]
   *     summary: Actualiza una ubicación frecuente propia
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Ubicación actualizada
   *       404:
   *         description: No encontrada o ajena
   *   delete:
   *     tags: [CitizenProfile]
   *     summary: Elimina una ubicación frecuente propia
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, format: uuid }
   *     responses:
   *       200:
   *         description: Eliminada
   *       404:
   *         description: No encontrada o ajena
   */
  router.patch('/saved-locations/:id', authenticate, requireCitizen, mutationLimiter, asyncHandler(async (req, res) => {
    res.json(await controller.updateSavedLocation(req.user, req.params.id, req.body));
  }));

  router.delete('/saved-locations/:id', authenticate, requireCitizen, mutationLimiter, asyncHandler(async (req, res) => {
    res.json(await controller.removeSavedLocation(req.user, req.params.id));
  }));

  return router;
}

module.exports = { createCitizenProfileRoutes };
