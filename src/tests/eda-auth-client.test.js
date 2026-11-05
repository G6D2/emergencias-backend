const { EdaAuthClient } = require('../services/eda-auth-client');

function mockFetchOk(token, expiresIn = 900, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }),
      text: async () => '',
    };
  };
}

function mockFetchStatus(status, body = '', calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (body ? JSON.parse(body) : {}),
      text: async () => body,
    };
  };
}

describe('EdaAuthClient (issue #74)', () => {
  const BASE = {
    tokenUrl: 'https://auth.example/oauth/token',
    clientId: 'grupo5',
    clientSecret: 'secreto',
  };

  it('isConfigured requiere las 3 variables', () => {
    expect(new EdaAuthClient(BASE).isConfigured()).toBe(true);
    expect(new EdaAuthClient({ ...BASE, clientSecret: '' }).isConfigured()).toBe(false);
    expect(new EdaAuthClient({ ...BASE, tokenUrl: null }).isConfigured()).toBe(false);
    expect(new EdaAuthClient({ ...BASE, clientId: undefined }).isConfigured()).toBe(false);
  });

  it('getToken sin configurar lanza con mensaje claro', async () => {
    const client = new EdaAuthClient({ fetch: async () => { throw new Error('no debe llamarse'); } });
    await expect(client.getToken()).rejects.toThrow(/EdaAuthClient no configurado/);
  });

  it('getToken: primera llamada hace POST con Basic auth y grant_type=client_credentials', async () => {
    const calls = [];
    const client = new EdaAuthClient({ ...BASE, fetch: mockFetchOk('tok-1', 900, calls) });

    const token = await client.getToken();

    expect(token).toBe('tok-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(BASE.tokenUrl);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('grant_type=client_credentials');
    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const expectedBasic = `Basic ${Buffer.from('grupo5:secreto').toString('base64')}`;
    expect(calls[0].init.headers.Authorization).toBe(expectedBasic);
  });

  it('getToken: segunda llamada usa el cache si el token no vencio (con buffer)', async () => {
    const calls = [];
    let now = 1_000_000;
    const client = new EdaAuthClient({
      ...BASE,
      fetch: mockFetchOk('tok-1', 900, calls),
      now: () => now,
    });

    expect(await client.getToken()).toBe('tok-1');
    now += 100_000; // 100s despues; expiry 900s, buffer 120s → aun valido
    expect(await client.getToken()).toBe('tok-1');
    expect(calls).toHaveLength(1);
  });

  it('getToken: renueva si falta menos que el buffer para expirar', async () => {
    const calls = [];
    let now = 1_000_000;
    let tokenCounter = 1;
    const client = new EdaAuthClient({
      ...BASE,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: `tok-${tokenCounter++}`, token_type: 'Bearer', expires_in: 900 }),
          text: async () => '',
        };
      },
      now: () => now,
    });

    expect(await client.getToken()).toBe('tok-1');
    now += 800_000; // 800s despues; faltan 100s para expirar; buffer 120s → renueva
    expect(await client.getToken()).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  it('invalidate() fuerza renovacion en la proxima getToken', async () => {
    const calls = [];
    let tokenCounter = 1;
    const client = new EdaAuthClient({
      ...BASE,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: `tok-${tokenCounter++}`, token_type: 'Bearer', expires_in: 900 }),
          text: async () => '',
        };
      },
    });

    expect(await client.getToken()).toBe('tok-1');
    client.invalidate();
    expect(await client.getToken()).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  it('getToken: llamadas concurrentes deduplican a UN solo request', async () => {
    const calls = [];
    let resolveFetch;
    const client = new EdaAuthClient({
      ...BASE,
      fetch: (url, init) => {
        calls.push({ url, init });
        return new Promise((resolve) => {
          resolveFetch = () => resolve({
            ok: true, status: 200,
            json: async () => ({ access_token: 'tok-concurrent', token_type: 'Bearer', expires_in: 900 }),
            text: async () => '',
          });
        });
      },
    });

    const p1 = client.getToken();
    const p2 = client.getToken();
    const p3 = client.getToken();
    expect(calls).toHaveLength(1);
    resolveFetch();
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect(t1).toBe('tok-concurrent');
    expect(t2).toBe('tok-concurrent');
    expect(t3).toBe('tok-concurrent');
    expect(calls).toHaveLength(1);
  });

  it('getToken: response !ok lanza con status y snippet del body', async () => {
    const client = new EdaAuthClient({
      ...BASE,
      fetch: mockFetchStatus(401, 'invalid_client'),
    });
    await expect(client.getToken()).rejects.toThrow(/EDA OAuth2 token request failed: 401 invalid_client/);
  });

  it('getToken: body sin access_token/expires_in lanza error', async () => {
    const client = new EdaAuthClient({
      ...BASE,
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({ malformado: true }),
        text: async () => '',
      }),
    });
    await expect(client.getToken()).rejects.toThrow(/EDA OAuth2 response invalida/);
  });

  it('tras un error fallido, pendingRefresh se limpia y la proxima llamada reintenta', async () => {
    const calls = [];
    let shouldFail = true;
    const client = new EdaAuthClient({
      ...BASE,
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (shouldFail) {
          return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
        }
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: 'tok-ok', expires_in: 900 }),
          text: async () => '',
        };
      },
    });

    await expect(client.getToken()).rejects.toThrow();
    shouldFail = false;
    expect(await client.getToken()).toBe('tok-ok');
    expect(calls).toHaveLength(2);
  });
});
