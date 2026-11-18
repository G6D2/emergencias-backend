// Issue #74: publisher HTTP al gateway EDA (ADR-025 del gateway).
//
// Reemplaza al KafkaService directo cuando EDA_PUBLISHER_MODE=gateway.
// POSTea payload.data al endpoint /api/v1/event-types/{fqn}/events donde
// fqn = com.citypass.emergencias.{payload.type}, con Bearer token de servicio.
//
// Clasificacion de errores (para que el outbox decida reintentar o descartar):
//   - 2xx -> OK, devuelve { eventId, payloadHash } desde body.metadata
//   - 401 -> invalidate token + reintenta UNA vez con token fresco (no cuenta como intento)
//   - 400 / 403 / 404 / 413 -> PermanentError (outbox marca FAILED sin reintentar)
//   - 429 -> error con `retryAfterMs` (outbox respeta el backoff del gateway)
//   - 5xx y otros -> transient (outbox reintenta con backoff exponencial)

// El gateway genera un eventId nuevo en cada POST y no acepta Idempotency-Key:
// si cortamos una request que el gateway igual termina publicando, el outbox
// la reintenta y el evento sale duplicado con otro eventId. Con 15 s pasó en
// prod (13/11): el gateway tardó ~30 s en confirmar. 45 s cubre esa latencia y
// queda por debajo del minuto tras el cual claimBatch reclama una fila en
// PROCESSING (si se pasara, otra instancia podría publicarla en paralelo).
const TIMEOUT_MS = 45_000;

// Solo salen al bus los tipos del contrato (issue #48 de demo-repository).
// EmergenciaPriorizada es interna (orden de despacho): no se registra en el
// catálogo y el outbox la marca SKIPPED sin llamar al gateway.
// EmergenciaVinculadaAContextoZona solo se encola con
// EVENTO_VINCULO_CONTEXTO_ENABLED=true, que se enciende recién cuando el tipo
// está registrado en el catálogo (si no, el gateway responde 404 y la fila
// queda FAILED).
// CriticidadClimaticaConfirmada: confirmación de que Emergencias recibió la
// alerta climática de Espacios (mismo contrato que Residuos). Solo se encola
// con CONFIRMACION_CLIMA_ENABLED=true; el tipo tiene que estar registrado en
// el catálogo.
const PUBLISHED_TYPES = new Set([
  'EmergenciaCreada',
  'EmergenciaActualizada',
  'EmergenciaVinculadaAContextoZona',
  'CriticidadClimaticaConfirmada',
]);

class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.isPermanent = true;
  }
}

class GatewayPublisher {
  constructor(authClient, options = {}) {
    this.authClient = authClient;
    this.baseUrl = options.baseUrl || process.env.EDA_API_URL;
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
  }

  // Compat con la interfaz de KafkaService: outbox-publisher.js llama a
  // isEnabled() antes de reclamar el batch.
  isEnabled() {
    return process.env.EDA_PUBLISHER_MODE === 'gateway';
  }

  async publishEvent(topic, payload) {
    if (!this.baseUrl) {
      throw new Error('EDA_API_URL no configurado para GatewayPublisher');
    }
    if (!PUBLISHED_TYPES.has(payload && payload.type)) {
      return { skipped: true };
    }
    const fqn = `com.citypass.emergencias.${payload.type}`;
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1/event-types/${encodeURIComponent(fqn)}/events`;
    const token = await this.authClient.getToken();
    let response = await this._post(url, token, payload.data);

    if (response.status === 401) {
      this.authClient.invalidate();
      const retryToken = await this.authClient.getToken();
      response = await this._post(url, retryToken, payload.data);
    }

    return this._handle(response);
  }

  async _post(url, token, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async _handle(response) {
    if (response.status >= 200 && response.status < 300) {
      let body = {};
      try { body = await response.json(); } catch (_) { /* 204 u otros sin body */ }
      return {
        eventId: body.metadata?.eventId || null,
        payloadHash: body.metadata?.payloadHash || null,
      };
    }
    const bodyText = await safeText(response);
    if (response.status === 429) {
      const retryAfterSec = Number(response.headers.get('retry-after'));
      const err = new Error(`Gateway 429 — rate limited: ${bodyText.slice(0, 200)}`);
      err.retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : null;
      throw err;
    }
    if ([400, 403, 404, 413].includes(response.status)) {
      throw new PermanentError(`Gateway ${response.status}: ${bodyText.slice(0, 200)}`);
    }
    // 401 ya se trato arriba; si llegamos aca de nuevo con 401, es permanente.
    if (response.status === 401) {
      throw new PermanentError(`Gateway 401 tras reintento: ${bodyText.slice(0, 200)}`);
    }
    throw new Error(`Gateway ${response.status}: ${bodyText.slice(0, 200)}`);
  }
}

async function safeText(response) {
  try { return await response.text(); } catch (_) { return ''; }
}

module.exports = { GatewayPublisher, PermanentError, PUBLISHED_TYPES, TIMEOUT_MS };
