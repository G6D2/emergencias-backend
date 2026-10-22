const { secureLog } = require('../security/secure-log');
const { MapperRegistry } = require('./mapper-registry');

// Unico punto de entrada de eventos externos (ADR #25). En PR 1 solo
// delega al EventBus la suscripcion y, al recibir, resuelve el mapper
// por nombre corto. La ejecucion de comandos y la dedup transaccional
// (tabla eventos_procesados) llegan en PR 2.
class Listener {
  constructor(eventBus, mapperRegistry, options = {}) {
    this.eventBus = eventBus;
    this.registry = mapperRegistry;
    this.topics = Array.isArray(options.topics) ? [...options.topics] : [];
    this.groupId = options.groupId || process.env.KAFKA_GROUP_ID || 'emergencias-integracion';
  }

  async start() {
    for (const topic of this.topics) {
      this.eventBus.subscribe(topic, (event) => this.handleEvent(topic, event), { groupId: this.groupId });
    }
    return this.eventBus.startConsumers();
  }

  async stop() {
    return this.eventBus.stopConsumers();
  }

  async handleEvent(topic, event) {
    const shortName = MapperRegistry.shortNameFromTopic(topic);
    const mapper = this.registry.lookup(shortName);
    if (!mapper) {
      secureLog('warn', 'Evento sin mapper registrado — descartado', { topic, shortName });
      return { discarded: true, reason: 'no-mapper' };
    }
    // PR 2: dedup transaccional (tabla eventos_procesados) + ejecucion de comandos.
    secureLog('info', 'Evento recibido (scaffold — procesamiento diferido a PR 2)', { topic, shortName });
    return { discarded: false, mapperFound: true, event };
  }
}

module.exports = { Listener };
