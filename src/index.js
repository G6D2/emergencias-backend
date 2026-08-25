require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { KafkaService } = require('./services/kafka.service');
const { createPanicButtonRoutes } = require('./routes/panic-button.routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Services
let kafkaService;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize Kafka and start server
async function start() {
  try {
    kafkaService = new KafkaService();
    await kafkaService.connect();
    console.log('✓ Kafka connected');

    // Routes - pass kafkaService instance
    app.use('/api/panic-button', createPanicButtonRoutes(kafkaService));

    // Error handling middleware
    app.use((err, req, res, next) => {
      console.error(err.stack);
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    });

    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

module.exports = app;
