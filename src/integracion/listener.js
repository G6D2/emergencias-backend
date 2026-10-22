const { secureLog } = require('../security/secure-log');
const { MapperRegistry } = require('./mapper-registry');

// Unico punto de entrada de eventos externos (ADR #25).
//
// handleEvent corre una unica transaccion que:
//  1. Marca el eventId como procesado (ON CONFLICT DO NOTHING => dedup).
//  2. Si es fresco, resuelve el mapper por nombre corto y ejecuta los
//     comandos devueltos sobre el mismo client (todo o nada).
//  3. Si es duplicado, hace ROLLBACK sin side effects.
//  4. Recien despues del COMMIT el consumer confirma offset en Kafka.
//
// El commit del offset lo hace el consumer en el callback de eachMessage,
// no el handler. Si el handler lanza, el consumer NO confirma offset y
// Kafka reintrega el mensaje.
class Listener {
  constructor(eventBus, mapperRegistry, options = {}) {
    this.eventBus = eventBus;
    this.registry = mapperRegistry;
    this.pool = options.pool;
    this.eventosProcesadosRepo = options.eventosProcesadosRepo;
    this.topics = Array.isArray(options.topics) ? [...options.topics] : [];
    this.groupId = options.groupId || process.env.KAFKA_GROUP_ID || 'emergencias-integracion';
    // Issue #37: evita que el modulo consuma sus propios eventos como insumo
    // para generar nuevas emergencias (loop infinito).
    this.ownNamespace = options.ownNamespace || process.env.EDA_OWN_NAMESPACE || 'com.citypass.emergencias';
  }

  async start() {
    for (const topic of this.topics) {
      this.eventBus.subscribe(topic, (message) => this.handleEvent(topic, message), { groupId: this.groupId });
    }
    return this.eventBus.startConsumers();
  }

  async stop() {
    return this.eventBus.stopConsumers();
  }

  isOwnEvent(eventTypeFqn, source) {
    if (!this.ownNamespace) return false;
    if (typeof eventTypeFqn === 'string' && eventTypeFqn.startsWith(`${this.ownNamespace}.`)) {
      return true;
    }
    if (typeof source === 'string' && source === this.ownNamespace) {
      return true;
    }
    return false;
  }

  async handleEvent(topic, message) {
    const metadata = (message && message.metadata) || {};
    const data = (message && message.data) || {};
    const eventTypeFqn = metadata.eventType || topic;
    const shortName = MapperRegistry.shortNameFromTopic(eventTypeFqn);

    // Issue #37: no auto-consumir eventos propios (serian bucle infinito).
    if (this.isOwnEvent(eventTypeFqn, metadata.source)) {
      secureLog('info', 'Evento del propio namespace — descartado para evitar auto-consumo', {
        topic,
        eventTypeFqn,
        source: metadata.source,
      });
      return { discarded: true, reason: 'own-namespace' };
    }

    const mapper = this.registry.lookup(shortName);
    if (!mapper) {
      secureLog('warn', 'Evento sin mapper registrado — descartado', { topic, shortName });
      return { discarded: true, reason: 'no-mapper' };
    }
    if (!metadata.eventId) {
      secureLog('warn', 'Evento sin metadata.eventId — descartado', { topic, shortName });
      return { discarded: true, reason: 'missing-event-id' };
    }

    if (!this.pool || !this.eventosProcesadosRepo) {
      throw new Error('Listener requiere pool y eventosProcesadosRepo para procesar eventos');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const fresh = await this.eventosProcesadosRepo.tryMarkProcessed(client, {
        eventId: metadata.eventId,
        source: metadata.source || 'unknown',
        eventType: eventTypeFqn,
        causationId: metadata.causationId || null,
      });

      if (!fresh) {
        await client.query('ROLLBACK');
        secureLog('info', 'Evento duplicado — descartado por dedup', {
          eventId: metadata.eventId,
          shortName,
        });
        return { discarded: true, reason: 'duplicate' };
      }

      const commands = (await mapper({ metadata, data })) || [];
      for (const command of commands) {
        if (!command || typeof command.execute !== 'function') {
          throw new Error('Comando invalido: debe exponer execute(ctx)');
        }
        await command.execute({
          client,
          metadata,
          causationId: metadata.eventId,
        });
      }

      await client.query('COMMIT');
      secureLog('info', 'Evento procesado', {
        eventId: metadata.eventId,
        shortName,
        commandCount: commands.length,
      });
      return { processed: true, commandCount: commands.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      secureLog('error', 'Error procesando evento — rollback', {
        eventId: metadata.eventId,
        topic,
        message: error.message,
      });
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { Listener };
