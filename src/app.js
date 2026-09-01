require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createPanicButtonRoutes } = require('./routes/panic-button.routes');
const { createEmergenciesRoutes } = require('./routes/emergencies.routes');

function createApp(kafkaService, emergencyRepository) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', async (req, res) => {
    const kafkaConnected = kafkaService ? await kafkaService.checkHealth() : false;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      kafka: kafkaConnected ? 'connected' : 'disconnected',
    });
  });

  app.use('/api/panic-button', createPanicButtonRoutes(kafkaService, emergencyRepository));
  app.use('/emergencies', createEmergenciesRoutes(kafkaService, emergencyRepository));

  app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.name || 'Internal Server Error', message: err.message });
  });

  return app;
}

module.exports = { createApp };
