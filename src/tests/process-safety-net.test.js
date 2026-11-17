const { EventEmitter } = require('events');
const { installProcessSafetyNet } = require('../utils/process-safety-net');

// Proceso falso: un EventEmitter con exit(). Así no se tocan los handlers del
// proceso real de Jest.
function fakeProcess() {
  const proc = new EventEmitter();
  proc.exit = jest.fn();
  return proc;
}

describe('installProcessSafetyNet', () => {
  let errorSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('un rechazo sin capturar se loguea y el proceso sigue', () => {
    const proc = fakeProcess();
    installProcessSafetyNet(proc);

    proc.emit('unhandledRejection', new TypeError('no se pudo leer x'), Promise.resolve());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0];
    expect(line).toMatch(/Rechazo de promesa sin capturar/);
    expect(line).toMatch(/"name":"TypeError"/);
    expect(line).toMatch(/"message":"no se pudo leer x"/);
    expect(line).toMatch(/"stack":/);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('un rechazo con un motivo que no es Error también se loguea', () => {
    const proc = fakeProcess();
    installProcessSafetyNet(proc);

    proc.emit('unhandledRejection', 'timeout');
    proc.emit('unhandledRejection', undefined);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0][0]).toMatch(/"message":"timeout"/);
    expect(errorSpy.mock.calls[1][0]).toMatch(/"message":"undefined"/);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('una excepción no capturada se loguea y termina el proceso con código 1', () => {
    const proc = fakeProcess();
    installProcessSafetyNet(proc);

    proc.emit('uncaughtException', new Error('boom'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/Excepción no capturada/);
    expect(errorSpy.mock.calls[0][0]).toMatch(/"message":"boom"/);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('por default se instala sobre el proceso real', () => {
    const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    try {
      installProcessSafetyNet();
      expect(onSpy.mock.calls.map(([event]) => event)).toEqual(['unhandledRejection', 'uncaughtException']);
    } finally {
      onSpy.mockRestore();
    }
  });
});
