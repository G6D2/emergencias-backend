require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { KafkaService } = require('./services/kafka.service');
const { createPanicButtonRoutes } = require('./routes/panic-button.routes');
const { getPool } = require('./db/pool');
const { EmergencyRepository } = require('./repositories/emergency.repository');
const { createEmergenciesRoutes } = require('./routes/emergencies.routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Services
let kafkaService;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    kafka: kafkaService?.isConnected() ? 'connected' : 'disconnected',
  });
});

// Initialize services and start server
async function start() {
  kafkaService = new KafkaService();
  const emergencyRepository = new EmergencyRepository(getPool());

  // Try to connect to Kafka, but don't fail if it's not ready
  kafkaService.connect().catch((err) => {
    console.error('Initial Kafka connection failed:', err.message);
  });

  // Routes - pass kafkaService and repository instances
  app.use('/api/panic-button', createPanicButtonRoutes(kafkaService, emergencyRepository));
  app.use('/emergencies', createEmergenciesRoutes(kafkaService, emergencyRepository));

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.name || 'Internal Server Error', message: err.message });
  });

  app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Health check: http://localhost:${PORT}/health`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

module.exports = app;
