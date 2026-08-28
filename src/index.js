require('dotenv').config();
const { KafkaService } = require('./services/kafka.service');
const { getPool } = require('./db/pool');
const { EmergencyRepository } = require('./repositories/emergency.repository');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

async function start() {
  const kafkaService = new KafkaService();
  const emergencyRepository = new EmergencyRepository(getPool());

  kafkaService.connect().catch((err) => {
    console.error('Initial Kafka connection failed:', err.message);
  });

  const app = createApp(kafkaService, emergencyRepository);

  app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Health check: http://localhost:${PORT}/health`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
