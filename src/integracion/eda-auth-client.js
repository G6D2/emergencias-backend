const { secureLog } = require('../security/secure-log');

// Cliente OAuth2 client-credentials para el gateway EDA.
//
// Para grupo5 (Emergencias): POST authUrl + Basic Auth clientId:clientSecret +
// grant_type=client_credentials -> {access_token, expires_in}.
// Lo usan el oauthBearerProvider del consumer Kafka SASL/OAUTHBEARER y el
// publisher HTTP POST al gateway. Cachea el token y lo renueva proactivamente
// cuando quedan menos de REFRESH_SKEW_MS de vida (para que la ventana no se
// cierre mientras un request esta en vuelo).
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_REFRESH_SKEW_MS = 60 * 1000;

class EdaAuthClient {
  constructor(options = {}) {
    this.authUrl = options.authUrl || process.env.EDA_AUTH_URL;
    this.clientId = options.clientId || process.env.EDA_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.EDA_CLIENT_SECRET;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.refreshSkewMs = options.refreshSkewMs || DEFAULT_REFRESH_SKEW_MS;
    this.cached = null;
    this.inflight = null;
  }

  isConfigured() {
    return Boolean(this.authUrl && this.clientId && this.clientSecret && typeof this.fetchImpl === 'function');
  }

  async getToken() {
    if (!this.isConfigured()) {
      throw new Error('EdaAuthClient no configurado: faltan EDA_AUTH_URL/EDA_CLIENT_ID/EDA_CLIENT_SECRET o fetch');
    }

    if (this.cached && this.now() < this.cached.expiresAtMs - this.refreshSkewMs) {
      return this.cached.accessToken;
    }

    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.requestNewToken()
      .then((token) => {
        this.cached = token;
        return token.accessToken;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  async requestNewToken() {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'client_credentials' });

    const response = await this.fetchImpl(this.authUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      secureLog('error', 'EdaAuthClient token request fallo', { status: response.status, detail });
      throw new Error(`EdaAuthClient: respuesta ${response.status} del endpoint de token`);
    }

    const payload = await response.json();
    const accessToken = payload.access_token;
    const expiresInSec = Number(payload.expires_in);
    if (!accessToken || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
      throw new Error('EdaAuthClient: respuesta sin access_token o expires_in valido');
    }

    return {
      accessToken,
      expiresAtMs: this.now() + expiresInSec * 1000,
    };
  }

  invalidate() {
    this.cached = null;
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (_) {
    return '<cuerpo no legible>';
  }
}

module.exports = { EdaAuthClient };
