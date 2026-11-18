const { ServiceUnavailableError } = require('../errors/app-errors');
const { secureLog } = require('../security/secure-log');

// Guía de Analítica: el módulo pide el HTML ya armado y lo muestra en un iframe.
// No se agregan datos, no se llama a /analytics/* y el token no va en la URL.
const DEFAULT_EMBED_URL =
  'https://citypass-backend-prod-becqetepcjbqa8c7.brazilsouth-01.azurewebsites.net/embed/emergencias';

const TIMEOUT_MS = 20_000;

const FORWARDED_HEADERS = [
  'content-type',
  'cache-control',
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
];

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    return headers.get(name) || undefined;
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

class AnaliticaEmbedClient {
  constructor(options = {}) {
    this.embedUrl = options.embedUrl || process.env.ANALITICA_EMBED_URL || DEFAULT_EMBED_URL;
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * GET del tablero. `accessToken` es el access token human del usuario
   * (el mismo Bearer con el que entró). Analítica valida firma, iss, aud y namespace.
   * @param {string} accessToken
   * @returns {Promise<{ status: number, body: string, headers: Record<string, string> }>}
   */
  async fetchDashboard(accessToken) {
    let url;
    try {
      url = new URL(this.embedUrl);
    } catch {
      secureLog('error', 'ANALITICA_EMBED_URL invalida');
      throw new ServiceUnavailableError('Analítica no disponible');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      secureLog('error', 'ANALITICA_EMBED_URL rechazada', { protocol: url.protocol });
      throw new ServiceUnavailableError('Analítica no disponible');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'text/html',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      const body = typeof response.text === 'function' ? await response.text() : '';
      const headers = {};
      for (const name of FORWARDED_HEADERS) {
        const value = headerValue(response.headers, name);
        if (value) headers[name] = value;
      }
      return { status: response.status, body, headers };
    } catch (err) {
      if (err instanceof ServiceUnavailableError) throw err;
      const timedOut = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      secureLog('error', 'No se pudo pedir el tablero de Analítica', {
        timedOut,
        name: err?.name,
      });
      throw new ServiceUnavailableError(
        timedOut ? 'Analítica no respondió a tiempo' : 'Analítica no disponible'
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  AnaliticaEmbedClient,
  DEFAULT_EMBED_URL,
  FORWARDED_HEADERS,
};
