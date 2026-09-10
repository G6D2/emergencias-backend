const express = require('express');
const { EmergencyController } = require('../controllers/emergency.controller');
const { asyncHandler } = require('../utils/async-handler');
const { requireCitizen, requireDispatcher, requireCitizenOrDispatcher } = require('../auth/authorize');

function createEmergenciesRoutes(kafkaService, emergencyRepository, authenticate) {
  const router = express.Router();
  const controller = new EmergencyController(kafkaService, emergencyRepository);

  /**
   * @openapi
   * /api/emergencies:
   *   get:
   *     tags: [Emergencies]
   *     summary: Lista emergencias paginadas
   *     description: |
   *       Requiere grupo `citizen` o `dispatcher`. Dispatcher ve todas; citizen solo las propias
   *       (se fuerza el filtro por el sub del JWT).
   *       Soporta filtros por status, severity, rango de fechas, oficial asignado y tipo de emergencia.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *         description: Lista de statuses separados por coma (ej. PENDING,VALIDATED)
   *       - in: query
   *         name: severity
   *         schema:
   *           type: string
   *       - in: query
   *         name: from
   *         schema:
   *           type: string
   *           format: date-time
   *       - in: query
   *         name: to
   *         schema:
   *           type: string
   *           format: date-time
   *       - in: query
   *         name: assignedOfficerId
   *         schema:
   *           type: string
   *       - in: query
   *         name: emergencyType
   *         schema:
   *           type: string
   *         description: Tipo canónico (MEDICA, INCENDIO, ...) o alias en inglés del front (medical, fire, ...). Inválido → 400.
   *       - in: query
   *         name: type
   *         schema:
   *           type: string
   *         description: Alias de emergencyType (compatibilidad)
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: sortBy
   *         schema:
   *           type: string
   *           enum: [createdAt, priority]
   *       - in: query
   *         name: order
   *         schema:
   *           type: string
   *           enum: [asc, desc]
   *     responses:
   *       200:
   *         description: Página de emergencias
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Grupo insuficiente
   */
  // Dispatcher: todas. Citizen: solo las propias (el filtro por user_id se
  // fuerza en el controller a partir del sub del JWT, no del query string).
  router.get('/', authenticate, requireCitizenOrDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.listEmergencies(req.query, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}:
   *   get:
   *     tags: [Emergencies]
   *     summary: Detalle completo de una emergencia
   *     description: |
   *       Devuelve la emergencia con su historial de estados en orden cronológico (tarea #32).
   *
   *       Reglas de acceso:
   *       - `dispatcher`: puede ver cualquier emergencia.
   *       - `citizen`: solo las propias. Si la emergencia es de otro usuario responde **404**
   *         (no 403) para no revelar la existencia de ids ajenos.
   *       - Cualquier otro grupo: 403.
   *
   *       `observations` y `reinforcementRequests` se devuelven siempre como listas vacías hasta que
   *       existan esas funcionalidades; el contrato ya contempla los campos para que el front no cambie.
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
   *         description: Detalle de la emergencia
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 data:
   *                   $ref: '#/components/schemas/EmergencyDetail'
   *       400:
   *         description: El id no tiene formato UUID
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       401:
   *         description: Token ausente o inválido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: Grupo insuficiente (requiere citizen o dispatcher)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Emergencia inexistente, o ajena para un citizen
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.get('/:id', authenticate, requireCitizenOrDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.getEmergencyDetail(req.params.id, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/validate:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Valida una emergencia pendiente
   *     description: |
   *       Requiere grupo `dispatcher`. Solo permite la transición PENDING -> VALIDATED.
   *       Registra el actor y publica EmergencyStatusUpdated en Kafka.
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
   *         description: Emergencia validada
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   *       404:
   *         description: Emergencia no encontrada
   *       409:
   *         description: La emergencia no está pendiente
   *       503:
   *         description: Kafka no disponible
   */
  router.patch('/:id/validate', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.validateEmergency(req.params.id, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/discard:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Descarta una emergencia pendiente
   *     description: |
   *       Requiere grupo `dispatcher`. Solo permite la transición PENDING -> DISCARDED.
   *       El motivo es obligatorio, se registra con el actor y se publica EmergencyStatusUpdated en Kafka.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/DiscardEmergencyRequest'
   *     responses:
   *       200:
   *         description: Emergencia descartada
   *       400:
   *         description: El motivo es obligatorio
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   *       404:
   *         description: Emergencia no encontrada
   *       409:
   *         description: La emergencia no está pendiente
   *       503:
   *         description: Kafka no disponible
   */
  router.patch('/:id/discard', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.discardEmergency(req.params.id, req.body || {}, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/assign:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Asigna un oficial a una emergencia validada
   *     description: |
   *       Requiere grupo `dispatcher`. Transición VALIDATED → DISPATCHED.
   *       El oficial debe existir y estar `disponible`; queda `ocupado`.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [officerId]
   *             properties:
   *               officerId:
   *                 type: string
   *                 example: of-001
   *     responses:
   *       200:
   *         description: Oficial asignado; emergencia en DISPATCHED
   *       400:
   *         description: officerId faltante o id inválido
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   *       404:
   *         description: Emergencia u oficial no encontrado
   *       409:
   *         description: Estado no asignable u oficial no disponible
   */
  router.patch('/:id/assign', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.assignOfficer(req.params.id, req.body || {}, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/cancel:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Cancela una emergencia
   *     description: |
   *       Requiere grupo `citizen` y ser dueño de la emergencia. Solo si el status actual es PENDING o VALIDATED.
   *       El actor se toma del JWT (claim `sub`). Publica EmergencyStatusUpdated en Kafka.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CancelEmergencyRequest'
   *     responses:
   *       200:
   *         description: Emergencia cancelada
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   $ref: '#/components/schemas/Emergency'
   *       401:
   *         description: Token ausente o inválido
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       403:
   *         description: No es el dueño o grupo insuficiente
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       404:
   *         description: Emergencia no encontrada
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       409:
   *         description: Estado no cancelable
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       503:
   *         description: Kafka no disponible
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.patch('/:id/cancel', authenticate, requireCitizen, asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    const result = await controller.cancelEmergency(req.params.id, { reason }, req.user);
    res.json(result);
  }));

  return router;
}

module.exports = { createEmergenciesRoutes };
