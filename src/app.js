const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec } = require('./swagger');
const { createPanicButtonRoutes } = require('./routes/panic-button.routes');
const { createEmergenciesRoutes } = require('./routes/emergencies.routes');

function createApp(kafkaService, emergencyRepository) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Emergencias API Docs',
  }));
  app.get('/api-docs.json', (req, res) => {
    res.json(swaggerSpec);
  });

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
    const kafkaConnected = kafkaService ? await kafkaService.checkHealth() : false;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      kafka: kafkaConnected ? 'connected' : 'disconnected',
    });
  });

  app.use('/api/panic-button', createPanicButtonRoutes(kafkaService, emergencyRepository));
  app.use('/api/emergencies', createEmergenciesRoutes(kafkaService, emergencyRepository));

  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) {
      console.error(err.stack);
    } else {
      console.warn(`${err.name}: ${err.message}`);
    }
    res.status(statusCode).json({ error: err.name || 'Internal Server Error', message: err.message });
  });

  return app;
}

module.exports = { createApp };
