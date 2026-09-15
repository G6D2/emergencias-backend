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
