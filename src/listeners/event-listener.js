const { secureLog } = require('../security/secure-log');
const { loadRules } = require('./load-rules');

// Listener abstracto de eventos externos (Kafka).
//
// Encapsula lo comun a cualquier suscripcion: crear el consumer, suscribirse
// al topic, parsear el mensaje y procesarlo con handle(). Cada tipo de evento
// al que nos suscribimos es una subclase concreta que define su topic y sus
// reglas de negocio.
//
// handle() es un template method (no sobreescribir). Las subclases definen
// los pasos:
//   - rulesDir (option)     carpeta con las reglas: cada *.rule.js se carga
//                           solo (ver load-rules.js). Alternativa: sobreescribir
//                           rules().
//   - buildContext(event)   opcional: normaliza el evento antes de evaluar.
// Devuelve los resultados { type, payload } de las reglas que aplican.
// onMessage() se los pasa a la factory (option), que los ejecuta en una sola
// transaccion. Un resultado sin factory que lo procese falla: no se pierde.
//
// Si handle() o la factory lanzan, el error se propaga a kafkajs: no se
// confirma el offset y el mensaje se reentrega.
class EventListener {
  constructor(kafka, options = {}) {
    if (new.target === EventListener) {
      throw new Error('EventListener es abstracto: extender y definir rulesDir');
    }
    if (!kafka) {
      throw new Error(`${this.constructor.name} requiere una instancia de Kafka`);
    }
    this.kafka = kafka;
    this.topic = options.topic;
    this.groupId = options.groupId || `emergencias-backend.${this.constructor.name}`;
    this.fromBeginning = options.fromBeginning === true;
    this.rulesDir = options.rulesDir;
    this.factory = options.factory || null;
    this.loadedRules = null;
    this.consumer = null;
  }

  async handle(event) {
    const context = this.buildContext(event);
    const outcomes = [];
    for (const rule of this.rules()) {
      if (!(await rule.appliesTo(context))) continue;
      const outcome = await rule.apply(context);
      if (!outcome || typeof outcome.type !== 'string' || !outcome.type) {
        throw new Error(`${rule.constructor.name}.apply() debe devolver { type, payload }`);
      }
      outcomes.push(outcome);
    }
    secureLog('info', `${this.constructor.name} proceso evento`, {
      eventId: context.metadata.eventId,
      outcomes: outcomes.map((o) => o.type),
    });
    return outcomes;
  }

  buildContext(event) {
    return {
      metadata: (event && event.metadata) || {},
      data: (event && event.data) || {},
    };
  }

  rules() {
    if (!this.rulesDir) {
      throw new Error(`${this.constructor.name} debe definir rulesDir o implementar rules()`);
    }
    if (!this.loadedRules) {
      this.loadedRules = loadRules(this.rulesDir);
    }
    return this.loadedRules;
  }

  async start() {
    if (!this.topic) {
      secureLog('warn', `${this.constructor.name} sin topic configurado — no se inicia`);
      return false;
    }
    if (this.consumer) return true;
    // Carga las reglas antes de conectar: una regla rota falla el arranque
    // en vez de cada mensaje.
    this.rules();

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
      return null;
    }
    const outcomes = await this.handle(event);
    if (!outcomes || outcomes.length === 0) return outcomes;
    await this.applyOutcomes(outcomes, event);
    return outcomes;
  }

  async applyOutcomes(outcomes, event) {
    const context = this.buildContext(event);
    try {
      if (!this.factory) {
        throw new Error(`${this.constructor.name} tiene resultados y no tiene factory`);
      }
      await this.factory.process(outcomes, context);
    } catch (error) {
      secureLog('error', `${this.constructor.name} no pudo aplicar los resultados`, {
        eventId: context.metadata.eventId,
        outcomes: outcomes.map((o) => o.type),
        message: error.message,
      });
      throw error;
    }
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
