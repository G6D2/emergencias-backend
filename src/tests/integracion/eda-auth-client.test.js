const { EdaAuthClient } = require('../../integracion/eda-auth-client');

describe('EdaAuthClient', () => {
  const makeFetchOk = (payload) => jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });

  const makeFetchFail = (status, body = 'nope') => jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  });

  const baseOpts = (overrides = {}) => ({
    authUrl: 'https://gateway/auth/oauth/token',
    clientId: 'grupo5',
    clientSecret: 'grupo5',
    ...overrides,
  });

  it('isConfigured false si falta algo', () => {
    expect(new EdaAuthClient({}).isConfigured()).toBe(false);
    expect(new EdaAuthClient({ authUrl: 'x', clientId: 'y' }).isConfigured()).toBe(false);
    const complete = new EdaAuthClient(baseOpts({ fetchImpl: jest.fn() }));
    expect(complete.isConfigured()).toBe(true);
  });

  it('getToken lanza si no esta configurado', async () => {
    const client = new EdaAuthClient({ fetchImpl: jest.fn() });
    await expect(client.getToken()).rejects.toThrow(/no configurado/);
  });

  it('getToken hace POST con Basic Auth y grant_type=client_credentials', async () => {
    const fetchImpl = makeFetchOk({ access_token: 'tkn-1', expires_in: 900 });
    const client = new EdaAuthClient(baseOpts({ fetchImpl, now: () => 1_000_000 }));
    const token = await client.getToken();

    expect(token).toBe('tkn-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway/auth/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: 'grant_type=client_credentials',
      })
    );
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Authorization).toMatch(/^Basic /);
    // Basic Auth: base64('grupo5:grupo5') = Z3J1cG81OmdydXBvNQ==
    expect(headers.Authorization).toBe('Basic Z3J1cG81OmdydXBvNQ==');
  });

  it('cachea el token mientras no venza (menos refreshSkewMs)', async () => {
    const fetchImpl = makeFetchOk({ access_token: 'tkn-1', expires_in: 900 });
    let fakeNow = 1_000_000;
    const client = new EdaAuthClient(baseOpts({
      fetchImpl,
      now: () => fakeNow,
      refreshSkewMs: 60_000,
    }));
    await client.getToken();
    // 100s despues: aun dentro de ventana (900 - 60 = 840s de vida util).
    fakeNow += 100_000;
    await client.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refresca el token cuando entra en la ventana de skew', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 't1', expires_in: 900 }), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 't2', expires_in: 900 }), text: async () => '' });
    let fakeNow = 0;
    const client = new EdaAuthClient(baseOpts({
      fetchImpl,
      now: () => fakeNow,
      refreshSkewMs: 60_000,
    }));
    await expect(client.getToken()).resolves.toBe('t1');
    // 850s despues: ya dentro de los ultimos 60s -> renueva.
    fakeNow = 850_000;
    await expect(client.getToken()).resolves.toBe('t2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('deduplica requests concurrentes (una sola llamada a fetch para dos getToken en paralelo)', async () => {
    let resolveFetch;
    const fetchImpl = jest.fn().mockImplementation(() => new Promise((r) => { resolveFetch = r; }));
    const client = new EdaAuthClient(baseOpts({ fetchImpl, now: () => 0 }));

    const p1 = client.getToken();
    const p2 = client.getToken();
    resolveFetch({ ok: true, status: 200, json: async () => ({ access_token: 'tkn', expires_in: 900 }), text: async () => '' });

    await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lanza si el gateway devuelve non-2xx', async () => {
    const fetchImpl = makeFetchFail(401, 'unauthorized');
    const client = new EdaAuthClient(baseOpts({ fetchImpl }));
    await expect(client.getToken()).rejects.toThrow(/401/);
  });

  it('lanza si el payload no trae access_token o expires_in valido', async () => {
    const fetchImpl = makeFetchOk({ access_token: null, expires_in: 900 });
    const client = new EdaAuthClient(baseOpts({ fetchImpl }));
    await expect(client.getToken()).rejects.toThrow(/access_token/);
  });

  it('lanza si expires_in no es numero positivo', async () => {
    const fetchImpl = makeFetchOk({ access_token: 'tkn', expires_in: 0 });
    const client = new EdaAuthClient(baseOpts({ fetchImpl }));
    await expect(client.getToken()).rejects.toThrow(/expires_in/);
  });

  it('tolera si response.text() falla al loguear detalle del error', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error('no body'); },
    });
    const client = new EdaAuthClient(baseOpts({ fetchImpl }));
    await expect(client.getToken()).rejects.toThrow(/500/);
  });

  it('invalidate limpia el cache', async () => {
    const fetchImpl = makeFetchOk({ access_token: 'tkn-1', expires_in: 900 });
    const client = new EdaAuthClient(baseOpts({ fetchImpl, now: () => 0 }));
    await client.getToken();
    client.invalidate();
    await client.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
