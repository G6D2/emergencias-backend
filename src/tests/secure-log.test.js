const { redactObject, summarizeEventForLog, secureLog } = require('../security/secure-log');

describe('redactObject', () => {
  it('redacta claves sensibles case-insensitive', () => {
    const redacted = redactObject({
      Authorization: 'Bearer abc', password: 'p', latitude: -34, LONGITUDE: -58,
      cookie: 'c', access_token: 't', refresh_token: 'r', location_encrypted: 'e', location: {},
    });
    expect(redacted).toEqual({
      Authorization: '[REDACTED]',
      password: '[REDACTED]',
      latitude: '[REDACTED]',
      LONGITUDE: '[REDACTED]',
      cookie: '[REDACTED]',
      access_token: '[REDACTED]',
      refresh_token: '[REDACTED]',
      location_encrypted: '[REDACTED]',
      location: '[REDACTED]',
    });
  });

  it('deja pasar null/undefined sin tocar', () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
    expect(redactObject('a string')).toBe('a string');
  });

  it('redacta un Bearer token embebido en un string', () => {
    expect(redactObject({ header: 'Bearer abc.def.ghi' })).toEqual({ header: 'Bearer [REDACTED]' });
  });

  it('redacta strings con forma de JWT', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    expect(redactObject({ token: jwt })).toEqual({ token: '[REDACTED_JWT]' });
  });

  it('redacta arrays de forma recursiva', () => {
    expect(redactObject({ items: [{ password: 'x' }, 'plain'] })).toEqual({
      items: [{ password: '[REDACTED]' }, 'plain'],
    });
  });

  it('redacta objetos anidados de forma recursiva', () => {
    expect(redactObject({ user: { password: 'x', name: 'Ana' } })).toEqual({
      user: { password: '[REDACTED]', name: 'Ana' },
    });
  });

  it('deja pasar valores no sensibles tal cual', () => {
    expect(redactObject({ status: 'ok', count: 3 })).toEqual({ status: 'ok', count: 3 });
  });

  it('deja pasar null/undefined dentro de un objeto', () => {
    expect(redactObject({ password: null, other: undefined })).toEqual({ password: null, other: undefined });
  });
});

describe('summarizeEventForLog', () => {
  it('devuelve solo el topic si no hay value o no es objeto', () => {
    expect(summarizeEventForLog('t', null)).toEqual({ topic: 't' });
    expect(summarizeEventForLog('t', 'string')).toEqual({ topic: 't' });
  });

  it('resume campos sin exponer coordenadas', () => {
    const summary = summarizeEventForLog('t', {
      type: 'EmergencyCreated', id: 'e-1', newStatus: 'VALIDATED', userId: 'u-1', actor: 'a', latitude: -34,
    });
    expect(summary).toEqual({
      topic: 't', type: 'EmergencyCreated', emergencyId: 'e-1', status: 'VALIDATED', userId: 'u-1', actor: 'a', hasLocation: true,
    });
  });

  it('hasLocation detecta location anidado', () => {
    const summary = summarizeEventForLog('t', { location: { latitude: 1, longitude: 2 } });
    expect(summary.hasLocation).toBe(true);
  });

  it('hasLocation es false sin coordenadas', () => {
    const summary = summarizeEventForLog('t', { type: 'x' });
    expect(summary.hasLocation).toBeFalsy();
  });
});

describe('secureLog', () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.LOG_LEVEL;
  });

  it('usa console.error para level error', () => {
    secureLog('error', 'boom', { password: 'x' });
    expect(errorSpy).toHaveBeenCalledWith('boom {"password":"[REDACTED]"}');
  });

  it('usa console.warn para level warn', () => {
    secureLog('warn', 'careful');
    expect(warnSpy).toHaveBeenCalledWith('careful');
  });

  it('usa console.log para cualquier otro level', () => {
    secureLog('info', 'all good', { count: 1 });
    expect(logSpy).toHaveBeenCalledWith('all good {"count":1}');
  });

  describe('nivel mínimo (LOG_LEVEL)', () => {
    // Emite un mensaje por nivel y devuelve cuáles llegaron a la consola.
    function emitted() {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        secureLog(level, `msg-${level}`);
      }
      return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map(([line]) => line.replace('msg-', ''));
    }

    it('por defecto es info: los debug no salen', () => {
      expect(emitted()).toEqual(['info', 'warn', 'error']);
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('LOG_LEVEL=debug deja salir todo, y debug va por console.log', () => {
      process.env.LOG_LEVEL = 'debug';
      expect(emitted()).toEqual(['debug', 'info', 'warn', 'error']);
      expect(logSpy).toHaveBeenCalledWith('msg-debug');
    });

    it('LOG_LEVEL=info es lo mismo que no definirla', () => {
      process.env.LOG_LEVEL = 'info';
      expect(emitted()).toEqual(['info', 'warn', 'error']);
    });

    it('LOG_LEVEL=warn calla info y debug', () => {
      process.env.LOG_LEVEL = 'warn';
      expect(emitted()).toEqual(['warn', 'error']);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('LOG_LEVEL=error deja solo los errores', () => {
      process.env.LOG_LEVEL = 'error';
      expect(emitted()).toEqual(['error']);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('no distingue mayúsculas ni espacios', () => {
      process.env.LOG_LEVEL = '  WARN ';
      expect(emitted()).toEqual(['warn', 'error']);
    });

    it.each(['verbose', '', '0', 'constructor', 'true'])('un valor inválido (%p) cae a info', (value) => {
      process.env.LOG_LEVEL = value;
      expect(emitted()).toEqual(['info', 'warn', 'error']);
    });

    it('un mensaje con un nivel desconocido se trata como info', () => {
      secureLog('trace', 'sin nivel conocido');
      expect(logSpy).toHaveBeenCalledWith('sin nivel conocido');

      logSpy.mockClear();
      process.env.LOG_LEVEL = 'warn';
      secureLog('trace', 'sin nivel conocido');
      secureLog(undefined, 'sin nivel');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('un mensaje que no sale tampoco arma el payload', () => {
      const meta = { toJSON: jest.fn(() => ({})) };
      secureLog('debug', 'no sale', meta);
      expect(meta.toJSON).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
