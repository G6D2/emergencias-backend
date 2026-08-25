const { Kafka } = require('kafkajs');

class KafkaService {
  constructor() {
    this.kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'emergencias-backend',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
    });
    this.producer = null;
    this.consumer = null;
  }

  async connect() {
    try {
      this.producer = this.kafka.producer();
      await this.producer.connect();
      console.log('Kafka producer connected');
    } catch (error) {
      console.error('Kafka connection error:', error);
      throw error;
    }
  }

  async publishEvent(topic, value) {
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
      console.log(`Event published to ${topic}:`, value);
    } catch (error) {
      console.error(`Error publishing event to ${topic}:`, error);
      throw error;
    }
  }

  async disconnect() {
    if (this.producer) {
      await this.producer.disconnect();
    }
    if (this.consumer) {
      await this.consumer.disconnect();
    }
  }
}

module.exports = { KafkaService };
