const { Kafka } = require('kafkajs');
const { secureLog } = require('../security/secure-log');

// Fachada del backend sobre el bus de eventos externos (ADR #25).
//
// Encapsula al KafkaService (producer, ya existente) y agrega el consumer
// del listener de integracion. Dos razones para separar el consumer en un
// cliente Kafka propio en vez de reusar el del producer:
//   1. Pueden apuntar a brokers distintos (produccion: Upstash para consumer
//      vs. Kafka local del compose para producer).
//   2. SASL/OAUTHBEARER del consumer no debe aplicar al producer local sin
//      autenticacion.
//
// Flags:
//   KAFKA_ENABLED           -> producer (KafkaService) ya existente.
//   KAFKA_CONSUMER_ENABLED  -> consumer de este modulo. Separado para poder
//                              apagar el consumer en entornos sin hosting
//                              always-on resuelto (Render free, Hito 1).
function defaultConsumerKafkaFactory({ edaAuthClient } = {}) {
  const brokers = (process.env.KAFKA_CONSUMER_BROKERS || process.env.KAFKA_BROKER || 'kafka:9092')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const sasl = edaAuthClient && edaAuthClient.isConfigured()
    ? {
      mechanism: 'oauthbearer',
      oauthBearerProvider: async () => ({ value: await edaAuthClient.getToken() }),
    }
    : undefined;

  return new Kafka({
    clientId: process.env.KAFKA_CONSUMER_CLIENT_ID || 'emergencias-integracion',
    brokers,
    ssl: process.env.KAFKA_CONSUMER_SSL === 'true',
    sasl,
    connectionTimeout: 10000,
    requestTimeout: 25000,
  });
}

class EventBus {
  constructor(kafkaService, options = {}) {
    this.kafkaService = kafkaService;
    this.consumerEnabled =
      options.consumerEnabled !== undefined
        ? Boolean(options.consumerEnabled)
        : process.env.KAFKA_CONSUMER_ENABLED === 'true';
    this.consumerGroupId =
      options.consumerGroupId || process.env.KAFKA_GROUP_ID || 'emergencias-integracion';
    this.edaAuthClient = options.edaAuthClient || null;
    this.consumerKafkaFactory = options.consumerKafkaFactory || defaultConsumerKafkaFactory;
    this.fromBeginning = options.fromBeginning === true;
    this.subscriptions = [];
    this.consumer = null;
  }

  isConsumerEnabled() {
    return this.consumerEnabled;
  }

  async publish(topic, event) {
    return this.kafkaService.publishEvent(topic, event);
  }

  subscribe(topic, handler, options = {}) {
    if (typeof topic !== 'string' || !topic) {
      throw new Error('subscribe requiere topic (string no vacio)');
    }
    if (typeof handler !== 'function') {
      throw new Error('subscribe requiere handler (function)');
    }
    this.subscriptions.push({ topic, handler, groupId: options.groupId });
    return this;
  }

  listSubscriptions() {
    return this.subscriptions.map(({ topic, groupId }) => ({ topic, groupId }));
  }

  async startConsumers() {
    if (!this.consumerEnabled) {
      secureLog('info', 'EventBus consumer disabled via KAFKA_CONSUMER_ENABLED — subscriptions registered but not active');
      return false;
    }
    if (this.subscriptions.length === 0) {
      secureLog('warn', 'EventBus.startConsumers sin suscripciones — nada que correr');
      return false;
    }
    if (this.consumer) {
      return true;
    }

    const kafka = this.consumerKafkaFactory({ edaAuthClient: this.edaAuthClient });
    this.consumer = kafka.consumer({ groupId: this.consumerGroupId });

    try {
      await this.consumer.connect();
      const uniqueTopics = [...new Set(this.subscriptions.map((s) => s.topic))];
      for (const topic of uniqueTopics) {
        await this.consumer.subscribe({ topic, fromBeginning: this.fromBeginning });
      }
      await this.consumer.run({
        eachMessage: async ({ topic, message }) => this.dispatchMessage(topic, message),
      });
      secureLog('info', 'EventBus consumer corriendo', {
        groupId: this.consumerGroupId,
        topics: uniqueTopics,
      });
      return true;
    } catch (error) {
      secureLog('error', 'EventBus consumer no pudo arrancar', { message: error.message });
      await this.consumer.disconnect().catch(() => {});
      this.consumer = null;
      throw error;
    }
  }

  async dispatchMessage(topic, message) {
    let value = null;
    if (message && message.value) {
      try {
        value = JSON.parse(message.value.toString());
      } catch (error) {
        secureLog('warn', 'EventBus descarto mensaje con JSON invalido', { topic, message: error.message });
        return;
      }
    }

    // Si hay varios handlers por topic, el primero gana. Hoy es 1:1 porque el
    // Listener de integracion es el unico consumidor del bus.
    const sub = this.subscriptions.find((s) => s.topic === topic);
    if (!sub) {
      secureLog('warn', 'EventBus recibio mensaje de topic sin handler', { topic });
      return;
    }
    await sub.handler(value);
  }

  async stopConsumers() {
    if (!this.consumer) return;
    try {
      await this.consumer.disconnect();
    } finally {
      this.consumer = null;
    }
  }
}

module.exports = { EventBus, defaultConsumerKafkaFactory };
