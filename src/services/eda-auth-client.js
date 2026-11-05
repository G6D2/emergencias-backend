// Issue #74: OAuth2 client-credentials para publicar al bus EDA.
//
// Flujo (Delfina 2026-11-02):
//   POST ${EDA_OAUTH_TOKEN_URL}
//   Authorization: Basic ${client_id}:${client_secret}
//   Content-Type: application/x-www-form-urlencoded
//   grant_type=client_credentials
//
// Devuelve { access_token, token_type: "Bearer", expires_in: 900 } con claim
// `namespace: "com.citypass.emergencias"`. El bus autoriza por este namespace.
//
// Cache en memoria con renovación proactiva (RENEW_BUFFER_MS antes del expiry)
// y reactiva (via invalidate() cuando el gateway responde 401). Thread-safe:
// pendingRefresh dedupe los requests concurrentes de muchos poll del outbox.

const RENEW_BUFFER_MS = 120_000;
const TIMEOUT_MS = 10_000;

class EdaAuthClient {
  constructor(options = {}) {
    this.tokenUrl = options.tokenUrl || process.env.EDA_OAUTH_TOKEN_URL;
    this.clientId = options.clientId || process.env.EDA_OAUTH_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.EDA_OAUTH_CLIENT_SECRET;
    this.fetch = options.fetch || globalThis.fetch;
    this.renewBufferMs = options.renewBufferMs ?? RENEW_BUFFER_MS;
    this.timeoutMs = options.timeoutMs || TIMEOUT_MS;
    this.now = options.now || (() => Date.now());
    this.cached = null;
    this.pendingRefresh = null;
  }

  isConfigured() {
    return Boolean(this.tokenUrl && this.clientId && this.clientSecret);
  }

  invalidate() {
    this.cached = null;
  }

  async getToken() {
    if (this.cached && this.now() < this.cached.expiresAt - this.renewBufferMs) {
      return this.cached.accessToken;
    }
    if (this.pendingRefresh) return this.pendingRefresh;

    this.pendingRefresh = this._fetchAndCache()
      .finally(() => { this.pendingRefresh = null; });
    return this.pendingRefresh;
  }

  async _fetchAndCache() {
    if (!this.isConfigured()) {
      throw new Error('EdaAuthClient no configurado: faltan EDA_OAUTH_TOKEN_URL / EDA_OAUTH_CLIENT_ID / EDA_OAUTH_CLIENT_SECRET');
    }
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await safeText(response);
        throw new Error(`EDA OAuth2 token request failed: ${response.status} ${body.slice(0, 200)}`);
      }
      const data = await response.json();
      if (!data.access_token || typeof data.expires_in !== 'number') {
        throw new Error('EDA OAuth2 response invalida: faltan access_token / expires_in');
      }
      this.cached = {
        accessToken: data.access_token,
        expiresAt: this.now() + data.expires_in * 1000,
      };
      return this.cached.accessToken;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(response) {
  try { return await response.text(); } catch (_) { return ''; }
}

module.exports = { EdaAuthClient, RENEW_BUFFER_MS };
