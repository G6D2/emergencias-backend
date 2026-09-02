const { Kafka } = require('kafkajs');
const { ServiceUnavailableError } = require('../errors/app-errors');

class KafkaService {
  constructor() {
    this.kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'emergencias-backend',
      brokers: [process.env.KAFKA_BROKER || 'kafka:9092'],
      connectionTimeout: 10000,
      requestTimeout: 25000,
      retry: {
        initialRetryTime: 300,
        retries: 8,
        maxRetryTime: 30000,
        multiplier: 2,
        randomizationFactor: 0.2,
      },
    });
    this.producer = null;
    this.connected = false;
  }

  async connect() {
    try {
      this.producer = this.kafka.producer({
        allowAutoTopicCreation: true,
        transactionTimeout: 30000,
      });
      await this.producer.connect();
      this.connected = true;
      console.log('✓ Kafka producer connected');
      return true;
    } catch (error) {
      console.error('Kafka connection error:', error.message);
      console.log('⚠️  Kafka no disponible — seguimos en modo degradado');
      this.connected = false;
      return false;
    }
  }

  isConnected() {
    return this.connected && this.producer !== null;
  }

  async checkHealth() {
    const admin = this.kafka.admin({ retry: { retries: 0 } });

    try {
      await admin.connect();
      return true;
    } catch (error) {
      return false;
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  async publishEvent(topic, value) {
    if (!this.isConnected()) {
      throw new ServiceUnavailableError(
        `Kafka not connected. Event not published to ${topic}`
      );
    }

    try {
      await this.producer.send({
        topic,
        messages: [
          {
            key: null,
            value: JSON.stringify(value),
          },
        ],
      });
      console.log(`✓ Event published to ${topic}:`, value);
    } catch (error) {
      this.connected = false;
      console.error(`Error publishing event to ${topic}:`, error);
      throw error;
    }
  }

  async disconnect() {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
      this.connected = false;
    }
  }
}

module.exports = { KafkaService };
