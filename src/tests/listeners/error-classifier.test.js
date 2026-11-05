const { isTransientError } = require('../../listeners/error-classifier');

describe('isTransientError', () => {
  it.each([
    ['conexión de Postgres', { code: '08006' }],
    ['admin shutdown', { code: '57P01' }],
    ['statement timeout', { code: '57014' }],
    ['sin conexiones libres', { code: '53300' }],
    ['deadlock', { code: '40P01' }],
    ['serialización', { code: '40001' }],
    ['red', { code: 'ECONNREFUSED' }],
    ['causa de red', { cause: { code: 'ETIMEDOUT' } }],
    ['base arrancando (Neon despertando)', { code: '57P03' }],
    ['marcado (OutcomeFactory: sin conexión o conexión cortada)', { transient: true, message: 'Connection terminated unexpectedly' }],
  ])('transitorio: %s', (_, props) => {
    expect(isTransientError(Object.assign(new Error(props.message || 'x'), props))).toBe(true);
  });

  it.each([
    ['dato inválido', { code: '22P02' }],
    ['constraint', { code: '23505' }],
    ['check', { code: '23514' }],
    ['type sin handler', { message: 'No hay un handler registrado para X' }],
    ['marcado', { permanent: true, code: 'ECONNREFUSED' }],
    ['desconocido', {}],
    // Antes se decidía por el texto: estos pasaban por transitorios y
    // trababan la partición reentregando para siempre.
    ['eventId con "timeout" en el valor', { code: '22P02', message: 'invalid input syntax for type uuid: "timeout-1"' }],
    ['texto sin código', { message: 'timeout exceeded when trying to connect' }],
    ['texto sin código (conexión)', { message: 'Connection terminated unexpectedly' }],
    ['dato inválido aunque la causa sea de red', { code: '23505', cause: { code: 'ECONNRESET' } }],
  ])('permanente: %s', (_, props) => {
    expect(isTransientError(Object.assign(new Error(props.message || 'x'), props))).toBe(false);
  });

  it('null no es transitorio', () => {
    expect(isTransientError(null)).toBe(false);
  });
});
