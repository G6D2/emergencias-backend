const { secureLog } = require('../security/secure-log');

// Listener abstracto de eventos externos (Kafka).
//
// Encapsula lo comun a cualquier suscripcion: crear el consumer, suscribirse
// al topic, parsear el mensaje y delegar en handle(). Cada tipo de evento al
// que nos suscribimos es una subclase concreta que solo define su topic y
// que hacer con el evento.
//
// Si handle() lanza, el error se propaga a kafkajs: no se confirma el offset
// y el mensaje se reentrega.
class EventListener {
  constructor(kafka, options = {}) {
    if (new.target === EventListener) {
      throw new Error('EventListener es abstracto: extender e implementar handle()');
    }
    if (!kafka) {
      throw new Error(`${this.constructor.name} requiere una instancia de Kafka`);
    }
    this.kafka = kafka;
    this.topic = options.topic;
    this.groupId = options.groupId || `emergencias-backend.${this.constructor.name}`;
    this.fromBeginning = options.fromBeginning === true;
    this.consumer = null;
  }

  // eslint-disable-next-line no-unused-vars
  async handle(event) {
    throw new Error(`${this.constructor.name} debe implementar handle(event)`);
  }

  async start() {
    if (!this.topic) {
      secureLog('warn', `${this.constructor.name} sin topic configurado — no se inicia`);
      return false;
    }
    if (this.consumer) return true;

    this.consumer = this.kafka.consumer({ groupId: this.groupId });
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: this.topic, fromBeginning: this.fromBeginning });
      await this.consumer.run({
        eachMessage: async ({ message }) => this.onMessage(message),
      });
      secureLog('info', `${this.constructor.name} escuchando`, { topic: this.topic, groupId: this.groupId });
      return true;
    } catch (error) {
      secureLog('error', `${this.constructor.name} no pudo arrancar`, { message: error.message });
      await this.consumer.disconnect().catch(() => {});
      this.consumer = null;
      throw error;
    }
  }

  async onMessage(message) {
    let event;
    try {
      event = JSON.parse(message.value.toString());
    } catch (error) {
      secureLog('warn', `${this.constructor.name} descarto mensaje con JSON invalido`, {
        topic: this.topic,
        message: error.message,
      });
      return;
    }
    await this.handle(event);
  }

  async stop() {
    if (!this.consumer) return;
    try {
      await this.consumer.disconnect();
    } finally {
      this.consumer = null;
    }
  }
}

module.exports = { EventListener };
