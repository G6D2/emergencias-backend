const express = require('express');
const { EmergencyController } = require('../controllers/emergency.controller');
const { asyncHandler } = require('../utils/async-handler');
const {
  requireCitizen,
  requireDispatcher,
  requireOfficer,
  requireCitizenOrDispatcher,
  requireCitizenDispatcherOrOfficer,
} = require('../auth/authorize');

function createEmergenciesRoutes(emergencyRepository, authenticate) {
  const router = express.Router();
  const controller = new EmergencyController(emergencyRepository);

  /**
   * @openapi
   * /api/emergencies:
   *   get:
   *     tags: [Emergencies]
   *     summary: Lista emergencias paginadas
   *     description: |
   *       Requiere grupo `citizen`, `dispatcher` u `officer`. Dispatcher ve todas; officer solo las
   *       que tiene asignadas (se fuerza `assignedOfficerId` = sub del JWT); citizen solo las propias
   *       (se fuerza el filtro por el sub del JWT). Officer y citizen las reciben sin `incident` ni
   *       `effectivePriority`.
   *       El officer recibe además `returned`: true en las que el dispatcher le devolvió (solo salen
   *       con `scope=history`), sin el oficial al que quedaron asignadas.
   *       Soporta filtros por status, severity, rango de fechas, oficial asignado y tipo de emergencia.
   *       Un filtro inválido responde 400 (no una lista vacía ni un 500).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *         description: |
   *           Lista de statuses separados por coma (ej. PENDING,VALIDATED). Valores válidos:
   *           PENDING, VALIDATED, DISPATCHED, EN_ROUTE, ON_SCENE, RESOLVED, CLOSED, CANCELLED, DISCARDED.
   *       - in: query
   *         name: scope
   *         schema:
   *           type: string
   *           enum: [active, history]
   *         description: |
   *           Solo officer, y no se combina con status (400). `active`: las suyas en DISPATCHED,
   *           EN_ROUTE u ON_SCENE. `history`: las suyas en RESOLVED, CLOSED o CANCELLED, más las que
   *           le devolvieron (aunque hoy estén con otro oficial).
   *       - in: query
   *         name: severity
   *         schema:
   *           type: string
   *           enum: [low, medium, high, critical]
   *       - in: query
   *         name: priority
   *         schema:
   *           type: string
   *           enum: [low, medium, high, critical]
   *         description: Alias de severity (se usa si no viene severity). Inválido → 400.
   *       - in: query
   *         name: from
   *         schema:
   *           type: string
   *           format: date-time
   *         description: Fecha ISO 8601 (ej. 2026-11-05 o 2026-11-05T10:00:00-03:00), sobre createdAt
   *       - in: query
   *         name: to
   *         schema:
   *           type: string
   *           format: date-time
   *         description: Fecha ISO 8601, sobre createdAt
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
   *       400:
   *         description: |
   *           Filtro inválido: status desconocido, severity, priority o emergencyType fuera del catálogo,
   *           from/to que no son una fecha ISO 8601, o scope desconocido, pedido por alguien que no es
   *           officer o junto con status
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Grupo insuficiente
   */
  // Dispatcher: todas. Officer: solo las asignadas a él. Citizen: solo las
  // propias. Los filtros de officer/citizen se fuerzan en el controller a
  // partir del sub del JWT, no del query string.
  router.get('/', authenticate, requireCitizenDispatcherOrOfficer, asyncHandler(async (req, res) => {
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
   *         (no 403) para no revelar la existencia de ids ajenos. Igual que en el listado, no
   *         recibe `incident` ni `effectivePriority` (información operativa).
   *       - Cualquier otro grupo: 403.
   *
   *       Cada lectura autorizada queda registrada en la auditoría de accesos (actor y emergencia).
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
    const result = await controller.getEmergencyDetail(req.params.id, req.user, { audit: true });
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/validate:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Valida una emergencia pendiente
   *     description: |
   *       Requiere grupo `dispatcher`. Solo permite la transición PENDING -> VALIDATED; una
   *       emergencia DISPATCHED se devuelve con `/return`, no con `/validate`.
   *       Registra el actor en el historial y publica `EmergenciaActualizada`.
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
   *       400:
   *         description: id inválido
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   *       404:
   *         description: Emergencia no encontrada
   *       409:
   *         description: La emergencia no está PENDING
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
   *       Requiere grupo `dispatcher`. Solo permite la transición PENDING -> DISCARDED y registra closedAt.
   *       El motivo es obligatorio y debe ser string: se le redacta la PII y se recorta a 280 caracteres.
   *       Se registra con el actor en el historial y se publica `EmergenciaActualizada`.
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
   *         description: id inválido, o motivo faltante, vacío o que no es string
   *       401:
   *         description: Token ausente o inválido
   *       403:
   *         description: Se requiere grupo dispatcher
   *       404:
   *         description: Emergencia no encontrada
   *       409:
   *         description: La emergencia no está pendiente
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
   * /api/emergencies/{id}/close:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Cierra una emergencia resuelta
   *     description: Requiere grupo `dispatcher`. Solo permite RESOLVED -> CLOSED y registra closedAt.
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
   *         description: Emergencia cerrada
   *       403:
   *         description: Se requiere grupo dispatcher
   *       404:
   *         description: Emergencia no encontrada
   *       409:
   *         description: La emergencia no está resuelta
   */
  router.patch('/:id/close', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.closeEmergency(req.params.id, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/return:
   *   patch:
   *     tags: [Emergencies]
   *     summary: Devuelve una emergencia despachada para reasignar (DISPATCHED → VALIDATED)
   *     description: |
   *       Dispatcher-only. Solo desde DISPATCHED. Libera al oficial asignado y deja `assignedOfficerId`
   *       en null. `reason` es opcional; si viene debe ser string (PII redactada, recorte a 280 caracteres).
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason: { type: string, nullable: true, maxLength: 280, example: Despacho equivocado }
   *     responses:
   *       200: { description: Emergencia devuelta a VALIDATED; oficial liberado }
   *       400: { description: id inválido o reason que no es string }
   *       401: { description: Token ausente o inválido }
   *       403: { description: Grupo insuficiente }
   *       404: { description: Emergencia no encontrada }
   *       409: { description: La emergencia no está DISPATCHED }
   */
  router.patch('/:id/return', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const result = await controller.returnEmergency(req.params.id, req.body || {}, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/en-route:
   *   patch:
   *     tags: [Emergencies]
   *     summary: El oficial asignado sale hacia la emergencia (DISPATCHED → EN_ROUTE)
   *     description: |
   *       Requiere grupo `officer`, y que el `sub` del token sea el oficial
   *       asignado a la emergencia. Registra el cambio en el historial y
   *       publica `EmergenciaActualizada`. Una emergencia inexistente o
   *       asignada a otro oficial responde 404.
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Emergencia en EN_ROUTE }
   *       400: { description: id inválido }
   *       401: { description: Token ausente o inválido }
   *       403: { description: Se requiere grupo officer }
   *       404: { description: Emergencia no encontrada o no asignada a este oficial }
   *       409: { description: La emergencia no está DISPATCHED }
   */
  router.patch('/:id/en-route', authenticate, requireOfficer, asyncHandler(async (req, res) => {
    const result = await controller.markEnRoute(req.params.id, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/on-scene:
   *   patch:
   *     tags: [Emergencies]
   *     summary: El oficial asignado llegó al lugar (EN_ROUTE → ON_SCENE)
   *     description: |
   *       Requiere grupo `officer`, y que el `sub` del token sea el oficial
   *       asignado a la emergencia. No se puede saltear el estado EN_ROUTE.
   *       Publica `EmergenciaActualizada`.
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
   *     responses:
   *       200: { description: Emergencia en ON_SCENE }
   *       400: { description: id inválido }
   *       401: { description: Token ausente o inválido }
   *       403: { description: Se requiere grupo officer }
   *       404: { description: Emergencia no encontrada o no asignada a este oficial }
   *       409: { description: La emergencia no está EN_ROUTE }
   */
  router.patch('/:id/on-scene', authenticate, requireOfficer, asyncHandler(async (req, res) => {
    const result = await controller.markOnScene(req.params.id, req.user);
    res.json(result);
  }));

  /**
   * @openapi
   * /api/emergencies/{id}/resolve:
   *   patch:
   *     tags: [Emergencies]
   *     summary: El oficial asignado resolvió la emergencia (ON_SCENE → RESOLVED)
   *     description: |
   *       Requiere grupo `officer`, y que el `sub` del token sea el oficial
   *       asignado a la emergencia. El cierre definitivo (RESOLVED → CLOSED)
   *       sigue siendo del dispatcher. Si `causasRelacionadas` incluye `VIA`,
   *       requiere `descripcionProblema` (máximo 280 caracteres). Publica
   *       `EmergenciaActualizada`.
   *     security: [{ bearerAuth: [] }]
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               causasRelacionadas:
   *                 type: array
   *                 items:
   *                   type: string
   *                   enum: [VIA, ESPACIO_PUBLICO, RESIDUOS]
   *                 default: []
   *               descripcionProblema:
   *                 type: string
   *                 maxLength: 280
   *                 description: Obligatoria si causasRelacionadas incluye VIA; se rechaza si no incluye VIA.
   *                 example: Bache profundo en la calzada junto a la esquina.
   *     responses:
   *       200: { description: Emergencia en RESOLVED }
   *       400: { description: id inválido }
   *       401: { description: Token ausente o inválido }
   *       403: { description: Se requiere grupo officer }
   *       404: { description: Emergencia no encontrada o no asignada a este oficial }
   *       409: { description: La emergencia no está ON_SCENE }
   */
  router.patch('/:id/resolve', authenticate, requireOfficer, asyncHandler(async (req, res) => {
    const result = await controller.markResolved(req.params.id, req.user, req.body || {});
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
   *       Registra closedAt. El actor se toma del JWT (claim `sub`). `reason` es opcional; si viene debe ser
   *       string (PII redactada, recorte a 280 caracteres). Publica `EmergenciaActualizada`.
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
   *       400:
   *         description: id inválido o reason que no es string
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
   */
  router.patch('/:id/cancel', authenticate, requireCitizen, asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    const result = await controller.cancelEmergency(req.params.id, { reason }, req.user);
    res.json(result);
  }));

  return router;
}

module.exports = { createEmergenciesRoutes };
