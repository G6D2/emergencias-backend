const {
  EMERGENCY_STATUSES,
  TRANSITIONS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  OFFICER_SCOPE_STATUSES,
  OFFICER_SCOPES,
  isValidStatus,
  isTerminal,
  canTransition,
  assertTransition,
} = require('../domain/emergency-status');

// Tabla completa de transiciones válidas (espejo de la spec de la tarea #10).
const VALID_TRANSITIONS = [
  ['PENDING', 'VALIDATED'],
  ['PENDING', 'CANCELLED'],
  ['PENDING', 'DISCARDED'],
  ['VALIDATED', 'DISPATCHED'],
  ['VALIDATED', 'CANCELLED'],
  ['DISPATCHED', 'EN_ROUTE'],
  ['DISPATCHED', 'VALIDATED'],
  ['EN_ROUTE', 'ON_SCENE'],
  ['ON_SCENE', 'RESOLVED'],
  ['RESOLVED', 'CLOSED'],
];

const INVALID_TRANSITIONS = [
  ['PENDING', 'RESOLVED'],
  ['PENDING', 'DISPATCHED'],
  ['PENDING', 'PENDING'],
  ['VALIDATED', 'PENDING'],
  ['VALIDATED', 'DISCARDED'],
  ['VALIDATED', 'ON_SCENE'],
  ['DISPATCHED', 'CANCELLED'],
  ['DISPATCHED', 'RESOLVED'],
  ['EN_ROUTE', 'DISPATCHED'],
  ['EN_ROUTE', 'RESOLVED'],
  ['ON_SCENE', 'CLOSED'],
  ['RESOLVED', 'ON_SCENE'],
  ['CLOSED', 'PENDING'],
];

describe('Máquina de estados de emergencias', () => {
  describe('catálogo de estados', () => {
    it('expone la lista completa y congelada de estados', () => {
      expect(EMERGENCY_STATUSES).toEqual([
        'PENDING',
        'VALIDATED',
        'DISPATCHED',
        'EN_ROUTE',
        'ON_SCENE',
        'RESOLVED',
        'CLOSED',
        'CANCELLED',
        'DISCARDED',
      ]);
      expect(Object.isFrozen(EMERGENCY_STATUSES)).toBe(true);
      expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    });

    it('define transiciones para todos los estados y solo apunta a estados conocidos', () => {
      expect(Object.keys(TRANSITIONS).sort()).toEqual([...EMERGENCY_STATUSES].sort());
      Object.values(TRANSITIONS).flat().forEach((target) => {
        expect(EMERGENCY_STATUSES).toContain(target);
      });
    });

    it('separa terminales de activos', () => {
      expect([...TERMINAL_STATUSES].sort()).toEqual(['CANCELLED', 'CLOSED', 'DISCARDED']);
      expect([...ACTIVE_STATUSES].sort()).toEqual(
        ['PENDING', 'VALIDATED', 'DISPATCHED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED'].sort()
      );
      TERMINAL_STATUSES.forEach((status) => expect(isTerminal(status)).toBe(true));
      ACTIVE_STATUSES.forEach((status) => expect(isTerminal(status)).toBe(false));
    });
  });

  describe('isValidStatus', () => {
    it.each(EMERGENCY_STATUSES)('acepta %s', (status) => {
      expect(isValidStatus(status)).toBe(true);
    });

    it.each([
      ['pending', 'minúsculas'],
      ['ON_SITE', 'nombre que no existe'],
      ['CREATED', 'estado legacy'],
      ['', 'string vacío'],
      [null, 'null'],
      [undefined, 'undefined'],
      [42, 'número'],
    ])('rechaza %p (%s)', (status) => {
      expect(isValidStatus(status)).toBe(false);
    });
  });

  describe('transiciones válidas', () => {
    it.each(VALID_TRANSITIONS)('%s → %s pasa', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    });

    it('la tabla del test cubre exactamente las transiciones del dominio', () => {
      const fromDomain = Object.entries(TRANSITIONS)
        .flatMap(([from, targets]) => targets.map((to) => `${from}->${to}`))
        .sort();
      const fromTest = VALID_TRANSITIONS.map(([from, to]) => `${from}->${to}`).sort();
      expect(fromDomain).toEqual(fromTest);
    });
  });

  describe('transiciones inválidas', () => {
    it.each(INVALID_TRANSITIONS)('%s → %s falla con 409', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(
        expect.objectContaining({ name: 'ConflictError', statusCode: 409 })
      );
    });

    it('usa un mensaje claro para el salto de flujo', () => {
      expect(() => assertTransition('PENDING', 'RESOLVED')).toThrow('Invalid transition PENDING → RESOLVED');
    });

    it('los estados terminales no admiten ninguna transición', () => {
      TERMINAL_STATUSES.forEach((from) => {
        EMERGENCY_STATUSES.forEach((to) => {
          expect(canTransition(from, to)).toBe(false);
          expect(() => assertTransition(from, to)).toThrow(
            expect.objectContaining({
              name: 'ConflictError',
              message: `Emergency in terminal status ${from} cannot transition to ${to}`,
            })
          );
        });
      });
    });

    it('rechaza estados desconocidos en origen o destino', () => {
      expect(canTransition('CREATED', 'VALIDATED')).toBe(false);
      expect(canTransition('PENDING', 'ON_SITE')).toBe(false);
      expect(canTransition('PENDING', null)).toBe(false);
      expect(() => assertTransition('PENDING', null)).toThrow(
        expect.objectContaining({ name: 'ConflictError', message: 'Unknown emergency status null' })
      );
      expect(() => assertTransition('CREATED', 'VALIDATED')).toThrow(
        expect.objectContaining({ name: 'ConflictError', message: 'Unknown emergency status CREATED' })
      );
    });
  });
});

describe('expiración (solo sistema)', () => {
  const { EXPIRATION_TARGETS, expirationTarget } = require('../domain/emergency-status');

  it('toda emergencia abierta tiene un estado terminal al que expira', () => {
    expect(Object.keys(EXPIRATION_TARGETS).sort()).toEqual([...ACTIVE_STATUSES].sort());
    for (const status of ACTIVE_STATUSES) {
      expect(TERMINAL_STATUSES).toContain(expirationTarget(status));
    }
  });

  it('lo resuelto se cierra y todo lo demás se cancela', () => {
    expect(expirationTarget('RESOLVED')).toBe('CLOSED');
    for (const status of ['PENDING', 'VALIDATED', 'DISPATCHED', 'EN_ROUTE', 'ON_SCENE']) {
      expect(expirationTarget(status)).toBe('CANCELLED');
    }
  });

  it('un estado terminal o desconocido no expira', () => {
    for (const status of [...TERMINAL_STATUSES, 'CREATED', null, undefined]) {
      expect(expirationTarget(status)).toBeNull();
    }
  });

  it('no abre atajos en los endpoints: cancelar lo despachado sigue sin ser una transición válida', () => {
    expect(canTransition('DISPATCHED', 'CANCELLED')).toBe(false);
    expect(canTransition('ON_SCENE', 'CANCELLED')).toBe(false);
  });
});

describe('OFFICER_SCOPE_STATUSES (vista del oficial, issue #17)', () => {
  it('reparte sin solaparse los estados en los que una emergencia puede tener oficial', () => {
    expect(OFFICER_SCOPES).toEqual(['active', 'history']);
    const { active, history } = OFFICER_SCOPE_STATUSES;
    expect(active.filter((status) => history.includes(status))).toEqual([]);
    // En curso: lo que el oficial todavía puede avanzar.
    expect(active.every((status) => ACTIVE_STATUSES.includes(status) && status !== 'RESOLVED')).toBe(true);
    // PENDING, VALIDATED y DISCARDED nunca tienen oficial asignado.
    expect([...active, ...history].sort()).toEqual(
      EMERGENCY_STATUSES.filter((status) => !['PENDING', 'VALIDATED', 'DISCARDED'].includes(status)).sort()
    );
  });
});
