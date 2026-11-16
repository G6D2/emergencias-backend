const { secureLog } = require('../security/secure-log');
const { loadRules } = require('./load-rules');
const { createEventDecoder } = require('./event-decoder');
const { isTransientError } = require('./error-classifier');

// El broker solo acepta consumer groups que empiecen con el namespace propio
// (sección 6 del README del gateway). El group.id lo arma EventConsumer.
const NAMESPACE = 'com.citypass.emergencias';

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
// Encapsula lo comun a cualquier evento: parsear el mensaje y procesarlo con
// handle(). Cada tipo de evento al que nos suscribimos es una subclase
// concreta que define su topic y sus reglas de negocio. La conexión al bus no
// es del listener: un solo EventConsumer (event-consumer.js) se suscribe a
// los topics de todos y le pasa a cada uno sus mensajes (onMessage).
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
  // `kafka` ya no se usa (la conexión es de EventConsumer). Queda como primer
  // parámetro para no cambiar la firma de las subclases ni de createListeners.
  // eslint-disable-next-line no-unused-vars
  constructor(kafka, options = {}) {
    if (new.target === EventListener) {
      throw new Error('EventListener es abstracto: extender y definir rulesDir');
    }
    this.topic = options.topic;
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
}

module.exports = { EventListener, NAMESPACE, resolveFromBeginning, resolveConsumeSince };
