const { secureLog } = require('../security/secure-log');

// Flag separado del KAFKA_ENABLED del producer: permite tener publicacion
// activa (outbox -> Kafka) y consumer apagado hasta que haya hosting always-on
// resuelto para el listener de integracion (ADR #25).
class EventBus {
  constructor(kafkaService, options = {}) {
    this.kafkaService = kafkaService;
    this.consumerEnabled =
      options.consumerEnabled !== undefined
        ? Boolean(options.consumerEnabled)
        : process.env.KAFKA_CONSUMER_ENABLED === 'true';
    this.subscriptions = [];
  }

  isConsumerEnabled() {
    return this.consumerEnabled;
  }

  async publish(topic, event) {
    return this.kafkaService.publishEvent(topic, event);
  }

  // PR 1 (scaffold): registra la intencion de suscripcion.
  // PR 2: el startConsumers conecta Kafka con SASL + OAUTHBEARER e itera.
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
    // Implementacion real del consumer: PR 2.
    secureLog('warn', 'EventBus.startConsumers aun no implementado (scaffold PR 1)');
    return false;
  }

  async stopConsumers() {
    return undefined;
  }
}

module.exports = { EventBus };
