const { secureLog } = require('../security/secure-log');
const { NAMESPACE } = require('./event-listener');

// Un solo consumer de Kafka para todos los listeners (ADR "Consumir todos los
// eventos externos con un solo consumer").
//
// Antes cada EventListener creaba su propio kafka.consumer() con su propio
// group.id. kafkajs abre 2 conexiones por consumer y por broker (una para
// Fetch y otra para el resto), así que cada listener sumaba 2 conexiones al
// broker del Grupo 1, que limita a 10 por IP. Con 6 listeners eran 12.
//
// Ahora hay un consumer y un group.id: se suscribe a los topics de todos los
// listeners y cada mensaje va al listener de su topic (listener.onMessage).
// Sumar un listener no suma conexiones.
//
// Mismo contrato que espera superviseListener: start() (true si arrancó,
// false si no hay nada que consumir), stop(), status() y onCrash.

const GROUP_SUFFIX = 'eventos';
const DEFAULT_MAX_CONCURRENCY = 3;

function groupIdFromEnv(env = process.env) {
  const prefix = env.KAFKA_CONSUMER_GROUP_PREFIX || NAMESPACE;
  return `${prefix}.${GROUP_SUFFIX}`;
}

// Cuántas particiones se procesan a la vez (partitionsConsumedConcurrently).
// Cada mensaje abre una transacción, y el pool de Postgres (DB_POOL_MAX, 10
// por default) se comparte con los requests HTTP y los jobs: con una por
// topic (6 hoy) el consumer solo podía ocupar más de la mitad del pool.
// Default: una por topic, hasta 3. KAFKA_CONSUMER_CONCURRENCY lo cambia
// (entero >= 1); un valor inválido se ignora y queda el default.
function concurrencyFromEnv(topicCount, env = process.env) {
  const fallback = Math.max(1, Math.min(topicCount, DEFAULT_MAX_CONCURRENCY));
  const raw = env.KAFKA_CONSUMER_CONCURRENCY;
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    secureLog('warn', 'KAFKA_CONSUMER_CONCURRENCY inválida: se usa el default', { value: raw, default: fallback });
    return fallback;
  }
  return value;
}

class EventConsumer {
  constructor(kafka, listeners, options = {}) {
    if (!kafka) {
      throw new Error('EventConsumer requiere una instancia de Kafka');
    }
    this.kafka = kafka;
    this.listeners = Array.isArray(listeners) ? listeners : [];
    this.groupId = options.groupId || groupIdFromEnv();
    if (!this.groupId.startsWith(`${NAMESPACE}.`)) {
      throw new Error(`EventConsumer: el group.id "${this.groupId}" tiene que empezar con ${NAMESPACE}.`);
    }
    this.byTopic = this.indexByTopic();
    this.consumer = null;
    // Estado para /health (ver status()).
    this.running = false;
    this.lastPollAt = null;
    // Lo setea superviseListener para volver a levantarlo si el consumer se
    // cae sin que kafkajs lo reinicie.
    this.onCrash = null;
  }

  // topic → listener. Dos listeners en el mismo topic compartirían el group y
  // el eventId de dedup: es un error de configuración y falla al construir.
  indexByTopic() {
    const byTopic = new Map();
    for (const listener of this.listeners) {
      if (!listener.topic) continue;
      const other = byTopic.get(listener.topic);
      if (other) {
        throw new Error(
          `EventConsumer: ${other.constructor.name} y ${listener.constructor.name} escuchan el mismo topic "${listener.topic}"`
        );
      }
      byTopic.set(listener.topic, listener);
    }
    return byTopic;
  }

  topics() {
    return [...this.byTopic.keys()];
  }

  async start() {
    for (const listener of this.listeners) {
      if (!listener.topic) {
        secureLog('warn', `${listener.constructor.name} sin topic configurado — no se consume`);
      }
    }
    if (this.byTopic.size === 0) return false;
    if (this.consumer) return true;
    // Carga las reglas antes de conectar: una regla rota falla el arranque
    // en vez de cada mensaje.
    for (const listener of this.byTopic.values()) listener.rules();

    this.consumer = this.kafka.consumer({ groupId: this.groupId });
    this.watchConsumer(this.consumer);
    try {
      await this.consumer.connect();
      for (const [topic, listener] of this.byTopic) {
        await this.consumer.subscribe({ topic, fromBeginning: listener.fromBeginning });
      }
      const concurrency = concurrencyFromEnv(this.byTopic.size);
      await this.consumer.run({
        // Una partición a la vez no alcanza: con 1 (el default de kafkajs) un
        // mensaje lento o un error transitorio en un topic frena a todos los
        // demás. Tampoco una por topic: ver concurrencyFromEnv.
        partitionsConsumedConcurrently: concurrency,
        eachMessage: async ({ topic, message }) => this.dispatch(topic, message),
      });
      this.running = true;
      secureLog('info', 'EventConsumer escuchando', {
        groupId: this.groupId,
        concurrency,
        topics: this.topics(),
        listeners: [...this.byTopic.values()].map((listener) => listener.constructor.name),
      });
      return true;
    } catch (error) {
      secureLog('error', 'EventConsumer no pudo arrancar', { message: error.message });
      await this.consumer.disconnect().catch(() => {});
      this.consumer = null;
      throw error;
    }
  }

  // Un topic sin listener no debería llegar (solo nos suscribimos a los
  // conocidos); si llega, se ignora y el offset avanza.
  async dispatch(topic, message) {
    const listener = this.byTopic.get(topic);
    if (!listener) {
      secureLog('warn', 'EventConsumer recibió un mensaje de un topic sin listener', { topic });
      return null;
    }
    return listener.onMessage(message);
  }

  // Cada fetch al broker marca lastPollAt: kafkajs hace long polling, así que
  // pasa cada pocos segundos aunque no haya mensajes. Un CRASH sin restart
  // deja el consumer desconectado y kafkajs no lo vuelve a levantar.
  watchConsumer(consumer) {
    const { FETCH_START, CRASH } = consumer.events;
    consumer.on(FETCH_START, () => {
      this.lastPollAt = new Date();
    });
    consumer.on(CRASH, ({ payload }) => {
      if (payload.restart || this.consumer !== consumer) return;
      this.running = false;
      this.consumer = null;
      secureLog('error', 'EventConsumer se cayó y kafkajs no lo reinicia', {
        message: payload.error?.message,
      });
      if (this.onCrash) this.onCrash(payload.error);
    });
  }

  status() {
    return {
      name: 'EventConsumer',
      groupId: this.groupId,
      running: this.running,
      lastPollAt: this.lastPollAt ? this.lastPollAt.toISOString() : null,
    };
  }

  // Estado de cada listener para GET /health, con la misma forma que antes
  // (un elemento por listener). Todos comparten el estado del consumer; un
  // listener sin topic figura como disabled.
  listenerStatuses(consumerStatus) {
    return this.listeners.map((listener) => {
      const name = listener.constructor.name;
      if (!listener.topic) {
        return { name, running: false, lastPollAt: null, status: 'disabled', nextRetryAt: null };
      }
      return {
        name,
        running: consumerStatus.running,
        lastPollAt: consumerStatus.lastPollAt,
        status: consumerStatus.status,
        nextRetryAt: consumerStatus.nextRetryAt,
      };
    });
  }

  async stop() {
    this.running = false;
    if (!this.consumer) return;
    try {
      await this.consumer.disconnect();
    } finally {
      this.consumer = null;
    }
  }
}

module.exports = { EventConsumer, groupIdFromEnv, concurrencyFromEnv, GROUP_SUFFIX };
