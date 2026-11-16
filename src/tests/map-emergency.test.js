const { mapEmergency } = require('../repositories/emergency.repository');

const row = {
  id: 'em-1',
  user_id: 'U1',
  latitude: null,
  longitude: null,
  location_encrypted: 'garbage',
  location_anonymized_at: null,
  description: 'x',
  severity: 'high',
  status: 'PENDING',
};

describe('mapEmergency', () => {
  it('devuelve la ubicación cuando el ciphertext abre', () => {
    const crypto = { decryptLocation: () => ({ latitude: -34.6, longitude: -58.4 }) };
    const mapped = mapEmergency(row, crypto);
    expect(mapped.latitude).toBe(-34.6);
    expect(mapped.locationUnavailable).toBe(false);
  });

  it('no lanza si el ciphertext no se puede descifrar: marca locationUnavailable', () => {
    const crypto = {
      decryptLocation: () => {
        throw new Error('Unsupported state or unable to authenticate data');
      },
    };
    const mapped = mapEmergency(row, crypto);
    expect(mapped.latitude).toBeNull();
    expect(mapped.longitude).toBeNull();
    expect(mapped.locationUnavailable).toBe(true);
    expect(mapped.locationAnonymized).toBe(false);
    expect(mapped.address).toBeNull();
  });

  it('devuelve la dirección legible cuando viene en el plaintext descifrado', () => {
    const crypto = {
      decryptLocation: () => ({ latitude: -34.6, longitude: -58.4, address: 'Av. Corrientes 1234' }),
    };
    const mapped = mapEmergency(row, crypto);
    expect(mapped.address).toBe('Av. Corrientes 1234');
  });

  it('address es null si el ciphertext no trae dirección (fila anterior a este cambio)', () => {
    const crypto = { decryptLocation: () => ({ latitude: -34.6, longitude: -58.4 }) };
    const mapped = mapEmergency(row, crypto);
    expect(mapped.address).toBeNull();
  });

  it('address es null si el ciphertext no se puede descifrar', () => {
    const crypto = {
      decryptLocation: () => {
        throw new Error('Unsupported state or unable to authenticate data');
      },
    };
    const mapped = mapEmergency(row, crypto);
    expect(mapped.address).toBeNull();
  });

  it('address es null cuando la ubicación fue anonimizada, aunque el ciphertext la tuviera', () => {
    const crypto = {
      decryptLocation: () => ({ latitude: -34.6, longitude: -58.4, address: 'no debería leerse' }),
    };
    const anonymizedRow = { ...row, location_anonymized_at: '2024-01-01' };
    const mapped = mapEmergency(anonymizedRow, crypto);
    expect(mapped.locationAnonymized).toBe(true);
    expect(mapped.address).toBeNull();
  });
});

describe('mapEmergency: aviso de ubicación indescifrable', () => {
  const brokenCrypto = {
    decryptLocation: () => {
      throw new Error('Unsupported state or unable to authenticate data');
    },
  };
  const AVISO = 'Location ciphertext could not be decrypted';
  let warnSpy;

  // El registro de ids ya avisados vive en el módulo mientras dura el
  // proceso: cada test carga una copia nueva para arrancar con él vacío.
  function loadRepositoryModule() {
    let loaded;
    jest.isolateModules(() => {
      loaded = require('../repositories/emergency.repository');
    });
    return loaded;
  }

  // Ids de las emergencias avisadas, en el orden en que salieron.
  function warnedIds() {
    return warnSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith(AVISO))
      .map((line) => JSON.parse(line.slice(AVISO.length)).emergencyId);
  }

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('avisa una sola vez por emergencia aunque la fila se lea muchas veces', () => {
    const { mapEmergency: map } = loadRepositoryModule();

    const mapped = [1, 2, 3].map(() => map(row, brokenCrypto));

    expect(warnedIds()).toEqual(['em-1']);
    expect(warnSpy).toHaveBeenCalledWith(
      `${AVISO} {"emergencyId":"em-1","message":"Unsupported state or unable to authenticate data"}`
    );
    // Lo que cambia es el log: la fila se sigue devolviendo igual cada vez.
    expect(mapped.map((emergency) => emergency.locationUnavailable)).toEqual([true, true, true]);
    expect(mapped.map((emergency) => emergency.latitude)).toEqual([null, null, null]);
  });

  it('cada emergencia distinta tiene su propio aviso', () => {
    const { mapEmergency: map } = loadRepositoryModule();

    map({ ...row, id: 'em-a' }, brokenCrypto);
    map({ ...row, id: 'em-b' }, brokenCrypto);
    map({ ...row, id: 'em-a' }, brokenCrypto);

    expect(warnedIds()).toEqual(['em-a', 'em-b']);
  });

  it('una fila que abre bien no avisa nada', () => {
    const { mapEmergency: map } = loadRepositoryModule();

    map(row, { decryptLocation: () => ({ latitude: -34.6, longitude: -58.4 }) });

    expect(warnedIds()).toEqual([]);
  });

  it('el listado consultado dos veces (el polling del front) avisa una vez por fila rota', async () => {
    const { EmergencyRepository } = loadRepositoryModule();
    const pool = {
      query: jest.fn(async (sql) => (sql.includes('AS total')
        ? { rows: [{ total: 2 }] }
        : { rows: [{ ...row, id: 'em-rota' }, { ...row, id: 'em-rota-2' }] })),
    };
    const repository = new EmergencyRepository(pool, { locationCrypto: brokenCrypto });
    const args = { statuses: [], page: 1, limit: 20, sortBy: 'createdAt', order: 'desc' };

    const first = await repository.findPage(args);
    const second = await repository.findPage(args);

    expect(warnedIds()).toEqual(['em-rota', 'em-rota-2']);
    expect(second).toEqual(first);
    expect(second.emergencies.every((emergency) => emergency.locationUnavailable)).toBe(true);
  });

  it('recuerda como mucho 1.000 ids: al pasarse olvida el más viejo', () => {
    const { mapEmergency: map } = loadRepositoryModule();
    const read = (id) => map({ ...row, id }, brokenCrypto);

    for (let i = 0; i < 1000; i += 1) read(`em-${i}`);
    expect(warnedIds()).toHaveLength(1000);

    // Con el registro lleno, los 1.000 siguen recordados...
    read('em-0');
    read('em-999');
    expect(warnedIds()).toHaveLength(1000);

    // ...y el id 1.001 entra desplazando al más viejo (em-0), no a los demás.
    read('em-1000');
    read('em-1000');
    read('em-999');
    read('em-1');
    expect(warnedIds()).toHaveLength(1001);

    // em-0 se olvidó: si vuelve a aparecer, avisa de nuevo (una vez).
    read('em-0');
    read('em-0');
    expect(warnedIds()).toHaveLength(1002);
    expect(warnedIds().slice(-2)).toEqual(['em-1000', 'em-0']);
  });
});
