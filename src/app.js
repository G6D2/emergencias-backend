const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec } = require('./swagger');
const { createPanicButtonRoutes } = require('./routes/panic-button.routes');
const { createEmergenciesRoutes } = require('./routes/emergencies.routes');
const { createUserRoutes } = require('./routes/user.routes');
const { createOutboxRoutes } = require('./routes/outbox.routes');
const { createAuthenticateMiddleware } = require('./auth/authenticate');
const { createSecurityMiddleware } = require('./security/security-headers');
const { secureLog } = require('./security/secure-log');

/**
 * @param {object} kafkaService
 * @param {object} emergencyRepository
 * @param {{
 *   authenticate?: import('express').RequestHandler,
 *   devAuthRouter?: import('express').Router|null,
 *   authMode?: string,
 * }} [options]
 */
function createApp(kafkaService, emergencyRepository, options = {}) {
  const app = express();
  const authenticate = options.authenticate || createAuthenticateMiddleware();

  app.set('trust proxy', 1);
  app.use(createSecurityMiddleware());
  app.use(cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((value) => value.trim())
      : true,
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
  app.use('/api/emergencies', createEmergenciesRoutes(kafkaService, emergencyRepository, authenticate));
  app.use('/api/outbox-events', createOutboxRoutes(emergencyRepository, authenticate));

  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) {
      secureLog('error', err.name || 'InternalServerError', {
        message: err.message,
        path: req.path,
        method: req.method,
      });
    } else {
      secureLog('warn', `${err.name}: ${err.message}`, {
        path: req.path,
        method: req.method,
        statusCode,
      });
    }
    res.status(statusCode).json({ error: err.name || 'Internal Server Error', message: err.message });
  });

  return app;
}

module.exports = { createApp };
