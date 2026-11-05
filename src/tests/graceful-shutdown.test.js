const http = require('http');
const { gracefulShutdown, closeServer } = require('../utils/graceful-shutdown');

describe('gracefulShutdown', () => {
  it('corre los pasos en orden, esperando cada uno, y devuelve 0', async () => {
    const order = [];
    const step = (name, ms) => ({
      name,
      run: () => new Promise((resolve) => {
        setTimeout(() => {
          order.push(name);
          resolve();
        }, ms);
      }),
    });

    const exitCode = await gracefulShutdown([step('server', 20), step('listeners', 5), step('pool', 0)]);

    expect(exitCode).toBe(0);
    expect(order).toEqual(['server', 'listeners', 'pool']);
  });

  it('si un paso falla, lo loguea y sigue con los demás (el pool se cierra igual)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const closePool = jest.fn().mockResolvedValue(undefined);

    const exitCode = await gracefulShutdown([
      { name: 'los listeners', run: () => Promise.reject(new Error('broker caído')) },
      { name: 'el pool de Postgres', run: closePool },
    ]);

    expect(exitCode).toBe(0);
    expect(closePool).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Shutdown: falló los listeners'));
    errorSpy.mockRestore();
  });

  it('si un paso se cuelga, al vencer el tope devuelve 1 sin esperar más', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const never = { name: 'el servidor HTTP', run: () => new Promise(() => {}) };
    const after = jest.fn();

    const exitCode = await gracefulShutdown([never, { name: 'el pool', run: after }], { timeoutMs: 20 });

    expect(exitCode).toBe(1);
    expect(after).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no terminó a tiempo'));
    errorSpy.mockRestore();
  });
});

describe('closeServer', () => {
  it('espera a que termine el request en curso antes de resolver', async () => {
    let finishRequest;
    const server = http.createServer((req, res) => {
      finishRequest = () => res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();

    const response = new Promise((resolve) => {
      http.get({ port, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
    });
    await new Promise((resolve) => {
      const wait = () => (finishRequest ? resolve() : setTimeout(wait, 5));
      wait();
    });

    let closed = false;
    const closing = closeServer(server).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    finishRequest();
    await expect(response).resolves.toBe(200);
    await closing;
    expect(closed).toBe(true);
  });

  it('rechaza si el server no estaba escuchando', async () => {
    await expect(closeServer(http.createServer())).rejects.toThrow();
  });
});
