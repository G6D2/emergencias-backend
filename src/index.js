require('dotenv').config();
const { KafkaService } = require('./services/kafka.service');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;

async function start() {
  const kafkaService = new KafkaService();

  kafkaService.connect().catch((err) => {
    console.error('Initial Kafka connection failed:', err.message);
  });

  const app = createApp(kafkaService);

  app.listen(PORT, () => {
    console.log(`✓ Server running on port ${PORT}`);
    console.log(`✓ Health check: http://localhost:${PORT}/health`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
