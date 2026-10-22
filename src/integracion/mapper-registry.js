// Registro de mappers (ADR #25). Indexado por nombre corto del event type
// (ultimo segmento del FQN Kafka), no por FQN completo: si el productor migra
// de namespace (ej. com.citypass.turismo -> com.citypass.espacios), basta con
// cambiar la env var del topico — el registry no se toca.
class MapperRegistry {
  constructor() {
    this.mappers = new Map();
  }

  register(eventTypeShortName, mapperFn) {
    if (typeof eventTypeShortName !== 'string' || !eventTypeShortName) {
      throw new Error('register requiere eventTypeShortName (string no vacio)');
    }
    if (typeof mapperFn !== 'function') {
      throw new Error('register requiere mapperFn (function)');
    }
    if (this.mappers.has(eventTypeShortName)) {
      throw new Error(`Mapper ya registrado para ${eventTypeShortName}`);
    }
    this.mappers.set(eventTypeShortName, mapperFn);
    return this;
  }

  lookup(eventTypeShortName) {
    return this.mappers.get(eventTypeShortName) || null;
  }

  size() {
    return this.mappers.size;
  }

  static shortNameFromTopic(topic) {
    if (typeof topic !== 'string') return null;
    if (!topic.includes('.')) return topic;
    return topic.split('.').pop();
  }
}

module.exports = { MapperRegistry };
