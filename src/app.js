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
const { createAuthenticateMiddleware } = require('./auth/authenticate');
const { createSecurityMiddleware } = require('./security/security-headers');
const { secureLog } = require('./security/secure-log');
const { resolveCorsOrigins } = require('./security/cors');

/**
 * @param {object} kafkaService
 * @param {object} emergencyRepository
 * @param {{
 *   authenticate?: import('express').RequestHandler,
 *   devAuthRouter?: import('express').Router|null,
 *   authMode?: string,
 *   officerRepository?: object|null,
 *   incidentRepository?: object|null,
 * }} [options]
 */
function createApp(kafkaService, emergencyRepository, options = {}) {
  const app = express();
  const authenticate = options.authenticate || createAuthenticateMiddleware();
  const officerRepository = options.officerRepository || null;
  const incidentRepository = options.incidentRepository || null;

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

  if (options.devAuthRouter) {
    app.use('/auth/dev', options.devAuthRouter);
  }

  /**
   * @openapi
   * /health:
   *   get:
   *     tags: [Health]
   *     summary: Health check del servicio
   *     description: Tirás esto para ver si el servicio está vivo y cómo anda Kafka.
   *     responses:
   *       200:
   *         description: Servicio operativo
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthResponse'
   */
  app.get('/health', async (req, res) => {
    const kafkaDisabled =
      kafkaService && typeof kafkaService.isEnabled === 'function' && !kafkaService.isEnabled();
    const kafkaConnected = kafkaService && !kafkaDisabled ? await kafkaService.checkHealth() : false;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      kafka: kafkaDisabled ? 'disabled' : kafkaConnected ? 'connected' : 'disconnected',
      authMode: options.authMode || undefined,
    });
  });

  app.use('/api/user', createUserRoutes(authenticate));
  app.use('/api/panic-button', createPanicButtonRoutes(kafkaService, emergencyRepository, authenticate));
  app.use(
    '/api/emergencies',
    createEmergenciesRoutes(kafkaService, emergencyRepository, authenticate)
  );
  app.use('/api/outbox-events', createOutboxRoutes(emergencyRepository, authenticate));
  if (officerRepository) {
    app.use('/api/officers', createOfficerRoutes(officerRepository, authenticate));
  }
  if (incidentRepository) {
    app.use('/api/incidents', createIncidentsRoutes(incidentRepository, authenticate));
  }

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
    res.status(statusCode).json({ error: err.name || 'Internal Server Error', message: err.message });
  });

  return app;
}

module.exports = { createApp };
