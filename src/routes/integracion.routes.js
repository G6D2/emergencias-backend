const express = require('express');
const { randomUUID } = require('crypto');
const { asyncHandler } = require('../utils/async-handler');
const { requireDispatcher } = require('../auth/authorize');
const { ValidationError } = require('../errors/app-errors');
const { secureLog } = require('../security/secure-log');

/**
 * Carga manual de eventos externos (ADR #25): mientras no haya consumer
 * always-on, el dispatcher puede pasar un evento por el mismo Listener que
 * usa Kafka (mapper, disparadores, dedup y transaccion).
 *
 * @param {{ handleEvent: Function }} integracionHandler - Listener sin EventBus
 */
function createIntegracionRoutes(integracionHandler, authenticate) {
  const router = express.Router();

  /**
   * @openapi
   * /api/integracion/eventos:
   *   post:
   *     tags: [Integracion]
   *     summary: Procesa a mano un evento externo (como si llegara por el bus)
   *     description: |
   *       Requiere grupo dispatcher. Pasa el evento por el mismo listener que el
   *       consumer de Kafka. Si no se manda `metadata.eventId`, se genera uno;
   *       repetir un `eventId` devuelve `discarded: true, reason: duplicate`.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [metadata, data]
   *             properties:
   *               metadata:
   *                 type: object
   *                 required: [eventType]
   *                 properties:
   *                   eventId:
   *                     type: string
   *                   eventType:
   *                     type: string
   *                   source:
   *                     type: string
   *               data:
   *                 type: object
   *           example:
   *             metadata:
   *               eventId: prueba-1
   *               eventType: com.citypass.espacios.EventoComunitarioPublicado
   *               source: com.citypass.espacios
   *             data:
   *               nombre: Feria del barrio
   *               capacidad: 100
   *     responses:
   *       200:
   *         description: Resultado del listener (`processed` o `discarded` con `reason`)
   *       400:
   *         description: Body invalido
   *       401:
   *         description: Token ausente o invalido
   *       403:
   *         description: Se requiere grupo dispatcher
   */
  router.post('/eventos', authenticate, requireDispatcher, asyncHandler(async (req, res) => {
    const { metadata, data } = req.body || {};
    if (!metadata || typeof metadata !== 'object' || typeof metadata.eventType !== 'string' || !metadata.eventType) {
      throw new ValidationError('metadata.eventType es obligatorio');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ValidationError('data debe ser un objeto');
    }

    const evento = {
      metadata: { ...metadata, eventId: metadata.eventId || randomUUID() },
      data,
    };

    secureLog('info', 'Evento externo cargado a mano', {
      actorSub: req.user.sub,
      eventId: evento.metadata.eventId,
      eventType: evento.metadata.eventType,
    });

    const result = await integracionHandler.handleEvent(evento.metadata.eventType, evento);
    res.json({ eventId: evento.metadata.eventId, ...result });
  }));

  return router;
}

module.exports = { createIntegracionRoutes };
