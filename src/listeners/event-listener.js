const { secureLog } = require('../security/secure-log');
const { loadRules } = require('./load-rules');
const { createEventDecoder } = require('./event-decoder');
const { isTransientError } = require('./error-classifier');

// El broker solo acepta consumer groups que empiecen con el namespace propio
// (sección 6 del README del gateway).
const NAMESPACE = 'com.citypass.emergencias';

function groupIdFor(listenerName) {
  const prefix = process.env.KAFKA_CONSUMER_GROUP_PREFIX || NAMESPACE;
  return `${prefix}.${listenerName}`;
}

// Dónde arranca un grupo sin offset commiteado (grupo nuevo, o uno que todavía
// no procesó ningún mensaje). Con false, kafkajs arranca en el final del topic
// y se pierde lo publicado mientras el proceso no corría: en Render free el
// servicio se duerme a los 15 min sin tráfico. Por eso el default es leer desde
// el principio. Con offset commiteado kafkajs retoma desde ahí, pero el grupo
// puede volver a quedar sin offset: Kafka borra los offsets de un grupo vacío
// a los 7 días (offsets.retention.minutes) y un OffsetOutOfRange también
// vuelve a usar fromBeginning. Por eso EDA_CONSUMER_SINCE queda cargada siempre.
function resolveFromBeginning(raw) {
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null || raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

// ISO 8601 con fecha, hora y zona explícita (Z u offset). Sin zona, new Date()
// la toma en hora local, y formatos como "05/11/2026" se leen como 11 de mayo.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
// Tolerancia de reloj para un piso "ahora mismo".
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Piso temporal del consumo (EDA_CONSUMER_SINCE, ISO 8601 UTC): al leer desde
// el principio, los mensajes con timestamp de Kafka anterior se saltean sin
// decodificarlos ni procesarlos (eventos de prueba viejos). Vacío = sin piso.
// Un piso en el futuro saltea en silencio todo lo que llegue hasta esa fecha y
// commitea los offsets: los eventos no se recuperan. Se rechaza al arrancar.
function resolveConsumeSince(raw, { now = Date.now() } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed;
  if (raw instanceof Date) {
    parsed = raw;
  } else {
    const text = String(raw).trim();
    if (!ISO_WITH_ZONE.test(text)) {
      throw new Error(`EDA_CONSUMER_SINCE invalido: "${raw}" no es ISO 8601 con zona (ej. 2026-11-05T15:00:00Z)`);
    }
    parsed = new Date(text);
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`EDA_CONSUMER_SINCE invalido: "${raw}" no es una fecha`);
  }
  if (parsed.getTime() > now + FUTURE_TOLERANCE_MS) {
    throw new Error(`EDA_CONSUMER_SINCE invalido: "${raw}" está en el futuro; saltearía todo lo que llegue hasta esa fecha`);
  }
  return parsed;
}

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
// Devuelve los resultados { type, payload } de las reglas que aplican, que
// despues ejecuta el OutcomeFactory en una transaccion con dedup.
//
// Errores (ver error-classifier.js): uno transitorio se propaga a kafkajs, que
// no confirma el offset y reentrega el mensaje. Uno permanente se registra como
// descartado y el offset avanza: nunca hay reentrega infinita.
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
    this.groupId = options.groupId || groupIdFor(this.constructor.name);
    if (!this.groupId.startsWith(`${NAMESPACE}.`)) {
      throw new Error(`${this.constructor.name}: el group.id "${this.groupId}" tiene que empezar con ${NAMESPACE}.`);
    }
    this.fromBeginning = resolveFromBeginning(
      options.fromBeginning !== undefined ? options.fromBeginning : process.env.EDA_CONSUMER_FROM_BEGINNING
    );
    this.consumeSince = resolveConsumeSince(
      options.consumeSince !== undefined ? options.consumeSince : process.env.EDA_CONSUMER_SINCE
    );
    this.rulesDir = options.rulesDir;
    this.factory = options.factory || null;
    this.decoder = options.decoder || createEventDecoder();
    this.loadedRules = null;
    this.consumer = null;
    // Estado para /health (ver status()).
    this.running = false;
    this.lastPollAt = null;
    // Lo setea quien supervisa el listener (listener-supervisor.js) para
    // volver a levantarlo si el consumer se cae sin que kafkajs lo reinicie.
    this.onCrash = null;
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
    this.watchConsumer(this.consumer);
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: this.topic, fromBeginning: this.fromBeginning });
      await this.consumer.run({
        eachMessage: async ({ message }) => this.onMessage(message),
      });
      this.running = true;
      secureLog('info', `${this.constructor.name} escuchando`, {
        topic: this.topic,
        groupId: this.groupId,
        fromBeginning: this.fromBeginning,
        since: this.consumeSince ? this.consumeSince.toISOString() : null,
      });
      return true;
    } catch (error) {
      secureLog('error', `${this.constructor.name} no pudo arrancar`, { message: error.message });
      await this.consumer.disconnect().catch(() => {});
      this.consumer = null;
      throw error;
    }
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
      secureLog('error', `${this.constructor.name} se cayó y kafkajs no lo reinicia`, {
        message: payload.error?.message,
      });
      if (this.onCrash) this.onCrash(payload.error);
    });
  }

  // Estado en memoria para GET /health.
  status() {
    return {
      name: this.constructor.name,
      running: this.running,
      lastPollAt: this.lastPollAt ? this.lastPollAt.toISOString() : null,
    };
  }

  // true si el mensaje es anterior a EDA_CONSUMER_SINCE. Sin timestamp
  // legible no se saltea: ante la duda, se procesa (la dedup cubre repetidos).
  // Kafka usa -1 para "sin timestamp"; null, "" y valores no positivos tampoco
  // son una fecha real. Ante la duda, se procesa (la dedup cubre repetidos).
  isBeforeSince(message) {
    if (!this.consumeSince || !message || message.timestamp === undefined || message.timestamp === null) return false;
    if (String(message.timestamp).trim() === '') return false;
    const ts = Number(message.timestamp);
    return Number.isFinite(ts) && ts > 0 && ts < this.consumeSince.getTime();
  }

  async onMessage(message) {
    if (this.isBeforeSince(message)) {
      // Se devuelve sin error: kafkajs da el offset por resuelto y lo commitea.
      secureLog('info', `${this.constructor.name} salteo un mensaje anterior a EDA_CONSUMER_SINCE`, {
        topic: this.topic,
        offset: message.offset,
        timestamp: new Date(Number(message.timestamp)).toISOString(),
      });
      return null;
    }

    let event;
    try {
      event = await this.decoder.decode(message.value);
    } catch (error) {
      if (isTransientError(error)) throw error;
      // Sin poder leerlo no hay eventId para registrarlo: se loguea y sigue.
      secureLog('warn', `${this.constructor.name} descarto un mensaje ilegible`, {
        topic: this.topic,
        message: error.message,
      });
      return null;
    }

    const context = this.buildContext(event);
    try {
      const outcomes = await this.handle(event);
      if (this.factory) {
        await this.factory.process(outcomes, context);
      }
      return outcomes;
    } catch (error) {
      if (isTransientError(error)) throw error;
      secureLog('error', `${this.constructor.name} descarto el evento`, {
        topic: this.topic,
        eventId: context.metadata.eventId,
        message: error.message,
      });
      await this.recordDiscard(context, error);
      return null;
    }
  }

  // Deja constancia del descarte en eventos_procesados. Si la base no
  // responde, el error es transitorio y el evento se reentrega.
  async recordDiscard(context, error) {
    if (!this.factory || typeof this.factory.recordDiscard !== 'function') return;
    try {
      await this.factory.recordDiscard(context, error.message);
    } catch (recordError) {
      if (isTransientError(recordError)) throw recordError;
      secureLog('warn', `${this.constructor.name} no pudo registrar el descarte`, {
        eventId: context.metadata.eventId,
        message: recordError.message,
      });
    }
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

module.exports = { EventListener, NAMESPACE, resolveFromBeginning, resolveConsumeSince };
