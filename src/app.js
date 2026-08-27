require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createPanicButtonRoutes } = require('./routes/panic-button.routes');

function createApp(kafkaService) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      kafka: kafkaService?.isConnected() ? 'connected' : 'disconnected',
    });
  });

  app.use('/api/panic-button', createPanicButtonRoutes(kafkaService));

  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  });

  return app;
}

module.exports = { createApp };
