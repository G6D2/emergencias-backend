const { secureLog, summarizeEventForLog } = require('../security/secure-log');

// Publisher HTTP para el gateway EDA (ADR #25).
//
// Hace POST ${apiUrl}/api/v1/event-types/${fqn}/events con Bearer y body = data.
// Interfaz drop-in compatible con KafkaService: isEnabled() + publishEvent(topic,
// payload). El OutboxPublisher selecciona entre KafkaService (default) y este
// via options.publisher — se habilita por EDA_PUBLISHER_MODE=gateway desde boot.
//
// publishEvent devuelve el envelope que respondio el gateway (metadata.eventId
// y metadata.payloadHash) cuando el POST fue 202, para que el OutboxPublisher
// pueda persistirlos en payload_hash / gateway_event_id (V20).
//
// Errores de publishEvent llevan flags:
//  - .status: codigo HTTP.
//  - .retryAfterMs: honrar backoff del gateway (429).
//  - .isPublishedPossibly: el evento puede haberse publicado igual (504);
//    el consumidor del error puede guardar payload_hash para dedup del retry.
//  - .isPermanent: contrato violado (400/404). No reintentar.
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 256 * 1024;

class GatewayPublisher {
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || process.env.EDA_API_URL || '').replace(/\/+$/, '');
    this.edaAuthClient = options.edaAuthClient || null;
    // Respeta null/undefined explicito pasado como opcion: solo cae al global
    // fetch cuando la clave 'fetchImpl' no viene en options. Esto permite a
    // los tests simular ambiente sin fetch disponible.
    this.fetchImpl = 'fetchImpl' in options ? options.fetchImpl : globalThis.fetch;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  }

  isEnabled() {
    return Boolean(this.apiUrl && this.edaAuthClient && typeof this.fetchImpl === 'function');
  }

  // Extrae el body que espera el gateway. El outbox guarda {type, eventId,
  // correlationId, data} para publicacion directa a Kafka; el gateway solo
  // acepta la parte data (metadata la calcula el). Si el payload viene plano
  // (sin .data) se pasa tal cual — util para builders futuros ya adaptados.
  static extractData(payload) {
    if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
      return payload.data;
    }
    return payload;
  }

  async publishEvent(topic, payload) {
    if (!this.isEnabled()) {
      secureLog('warn', 'GatewayPublisher no configurado — evento no publicado', summarizeEventForLog(topic, payload));
      return false;
    }

    if (typeof topic !== 'string' || !topic.includes('.')) {
      const err = new Error(`GatewayPublisher: topic ${JSON.stringify(topic)} no es un FQN valido`);
      err.isPermanent = true;
      throw err;
    }

    const data = GatewayPublisher.extractData(payload);
    const body = JSON.stringify(data);

    if (Buffer.byteLength(body, 'utf8') > this.maxBodyBytes) {
      const err = new Error(`GatewayPublisher: payload supera ${this.maxBodyBytes} bytes`);
      err.isPermanent = true;
      throw err;
    }

    const token = await this.edaAuthClient.getToken();
    const url = `${this.apiUrl}/api/v1/event-types/${encodeURIComponent(topic)}/events`;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (networkError) {
      const err = new Error(`GatewayPublisher: fallo de red publicando ${topic}: ${networkError.message}`);
      err.cause = networkError;
      throw err;
    }

    if (response.status === 202) {
      const envelope = await safeJson(response);
      const metadata = (envelope && envelope.metadata) || {};
      secureLog('info', 'Event published to gateway', {
        ...summarizeEventForLog(topic, payload),
        eventId: metadata.eventId,
      });
      return {
        ok: true,
        eventId: metadata.eventId || null,
        payloadHash: metadata.payloadHash || null,
        envelope,
      };
    }

    const detail = await safeText(response);
    const err = new Error(`GatewayPublisher: respuesta ${response.status} publicando ${topic}`);
    err.status = response.status;
    err.detail = detail;

    if (response.status === 429) {
      err.retryAfterMs = parseRetryAfter(response.headers && response.headers.get && response.headers.get('Retry-After'));
    }
    if (response.status === 504) {
      // Puede haberse publicado igual: el consumer del error decide si reintenta
      // (payload identico => mismo payloadHash => el gateway lo detecta duplicado).
      err.isPublishedPossibly = true;
    }
    if (response.status === 400 || response.status === 404 || response.status === 413) {
      // Contrato violado, schema desconocido, body gigante: no sirve reintentar.
      err.isPermanent = true;
    }

    throw err;
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 2000);
  } catch (_) {
    return '<cuerpo no legible>';
  }
}

// Retry-After puede ser un numero (segundos) o una fecha HTTP. Devuelve ms.
function parseRetryAfter(value) {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

module.exports = { GatewayPublisher };
