const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec } = require('./swagger');
const { createPanicButtonRoutes } = require('./routes/panic-button.routes');
const { createEmergenciesRoutes } = require('./routes/emergencies.routes');
const { createUserRoutes } = require('./routes/user.routes');
const { createOutboxRoutes } = require('./routes/outbox.routes');
const { createOfficerRoutes } = require('./routes/officer.routes');
const { createIncidentsRoutes } = require('./routes/incidents.routes');
const { createCitizenProfileRoutes } = require('./routes/citizen-profile.routes');
const { createContextosZonaRoutes } = require('./routes/contextos-zona.routes');
const { createAsyncApiRoutes } = require('./routes/asyncapi.routes');
const { createAuthenticateMiddleware } = require('./auth/authenticate');
const { createSecurityMiddleware } = require('./security/security-headers');
const { secureLog } = require('./security/secure-log');
const { resolveCorsOrigins } = require('./security/cors');
const { kafkaHealth } = require('./services/kafka.service');

// Los errores de express.json() traen el texto de la librería (o el de
// JSON.parse) en inglés. Se traducen por `type`; el `error` queda como viene
// (SyntaxError, PayloadTooLargeError...) y el texto original va al log.
const BODY_PARSER_MESSAGES = new Map([
  ['entity.parse.failed', 'El cuerpo del pedido no es un JSON válido'],
  ['entity.too.large', 'El cuerpo del pedido es demasiado grande'],
  ['encoding.unsupported', 'Content-Encoding no soportado'],
  ['charset.unsupported', 'Charset no soportado'],
  ['request.aborted', 'El pedido se cortó antes de terminar'],
  ['request.size.invalid', 'El tamaño del cuerpo no coincide con Content-Length'],
]);

/**
 * @param {object} kafkaService - solo para GET /health (kafkaHealth)
 * @param {object} emergencyRepository
 * @param {{
 *   authenticate?: import('express').RequestHandler,
 *   devAuthRouter?: import('express').Router|null,
 *   health?: () => object,
 *   officerRepository?: object|null,
 *   incidentRepository?: object|null,
 *   citizenProfileRepository?: object|null,
 *   contextoZonaRepository?: object|null,
 * }} [options]
 */
function createApp(kafkaService, emergencyRepository, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  const authenticate = options.authenticate || createAuthenticateMiddleware();
  const officerRepository = options.officerRepository || null;
  const incidentRepository = options.incidentRepository || null;
  const citizenProfileRepository = options.citizenProfileRepository || null;
  const contextoZonaRepository = options.contextoZonaRepository || null;

  app.set('trust proxy', 1);
  app.use(createSecurityMiddleware());
  app.use(cors({
    origin: resolveCorsOrigins(),
  }));
  app.use(express.json({ limit: '32kb' }));

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Emergencias API Docs',
  }));
  app.get('/api-docs.json', (req, res) => {
    res.json(swaggerSpec);
  });
  // Contrato de eventos (asyncapi.yaml): /asyncapi y /asyncapi.yaml.
  app.use(createAsyncApiRoutes());

  if (options.devAuthRouter) {
    app.use('/auth', options.devAuthRouter);
  }

  /**
   * @openapi
   * /health:
   *   get:
   *     tags: [Health]
   *     summary: Health check del servicio
   *     description: >
   *       Tirás esto para ver si el servicio está vivo y cómo anda Kafka. Responde con
   *       el estado que el proceso ya tiene en memoria (producer del outbox y cada
   *       listener): no abre conexiones al broker ni a la base.
   *     responses:
   *       200:
   *         description: Servicio operativo
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthResponse'
   */
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...(options.health ? options.health() : kafkaHealth(kafkaService)),
    });
  });

  app.use('/api/user', createUserRoutes(authenticate));
  app.use('/api/panic-button', createPanicButtonRoutes(emergencyRepository, authenticate));
  app.use('/api/emergencies', createEmergenciesRoutes(emergencyRepository, authenticate));
  app.use('/api/outbox-events', createOutboxRoutes(emergencyRepository, authenticate));
  if (officerRepository) {
    app.use('/api/officers', createOfficerRoutes(officerRepository, authenticate));
  }
  if (incidentRepository) {
    app.use('/api/incidents', createIncidentsRoutes(incidentRepository, authenticate));
  }
  if (citizenProfileRepository) {
    app.use('/api/citizen', createCitizenProfileRoutes(citizenProfileRepository, authenticate));
  }
  if (contextoZonaRepository) {
    app.use('/api/contextos-zona', createContextosZonaRoutes(contextoZonaRepository, authenticate));
  }

  // Ruta o método no soportado: 404 en JSON con el mismo shape { error, message }
  // que el resto de la API, en vez del 404 HTML por defecto de Express.
  app.use((req, res) => {
    res.status(404).json({
      error: 'NotFoundError',
      message: `No existe la ruta ${req.method} ${req.path}`,
    });
  });

  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;

    if (statusCode >= 500) {
      // El detalle (stack, mensaje crudo de Postgres, etc.) solo va al log,
      // nunca a la respuesta: podría filtrar detalles internos al cliente.
      secureLog('error', err.name || 'InternalServerError', {
        message: err.message,
        path: req.path,
        method: req.method,
      });
      res.status(statusCode).json({ error: 'InternalServerError', message: 'Error interno' });
      return;
    }

    secureLog('warn', `${err.name}: ${err.message}`, {
      path: req.path,
      method: req.method,
      statusCode,
    });
    res.status(statusCode).json({
      error: err.name || 'Internal Server Error',
      message: BODY_PARSER_MESSAGES.get(err.type) || err.message,
    });
  });

  return app;
}

module.exports = { createApp };
