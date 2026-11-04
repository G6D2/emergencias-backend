const { createProgramarCoberturaHandler, PROGRAMAR_COBERTURA } = require('../../listeners/cobertura-preventiva/handlers/programar-cobertura.handler');

function buildDeps(overrides = {}) {
  const locationCrypto = { encryptLocation: jest.fn().mockReturnValue('enc-loc') };
  const emergencyRepository = { insertOutboxEvent: jest.fn().mockResolvedValue(undefined) };
  const topic = 'com.citypass.emergencias';
  return { locationCrypto, emergencyRepository, topic, ...overrides };
}

function buildClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [{ id: 'row-1' }] }) };
}

describe('PROGRAMAR_COBERTURA', () => {
  it('exporta el nombre de tipo', () => {
    expect(PROGRAMAR_COBERTURA).toBe('ProgramarCobertura');
  });
});

describe('createProgramarCoberturaHandler', () => {
  it('falla sin locationCrypto', () => {
    expect(() => createProgramarCoberturaHandler({ emergencyRepository: {}, topic: 't' }))
      .toThrow(/locationCrypto/);
  });

  it('falla sin emergencyRepository', () => {
    expect(() => createProgramarCoberturaHandler({ locationCrypto: {}, topic: 't' }))
      .toThrow(/emergencyRepository/);
  });

  it('falla sin topic', () => {
    expect(() => createProgramarCoberturaHandler({ locationCrypto: {}, emergencyRepository: {} }))
      .toThrow(/topic/);
  });

  describe('handler', () => {
    const payload = {
      nombre: 'Carnaval de San Telmo',
      latitud: -34.615,
      longitud: -58.371,
      capacidad: 2000,
      causationEventId: 'caus-1',
    };

    it('inserta emergencia con source=EXTERNAL y severity=low', async () => {
      const deps = buildDeps();
      const client = buildClient();
      await createProgramarCoberturaHandler(deps)(client, payload);

      const [sql, values] = client.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO emergencies/);
      expect(sql).toMatch(/'EXTERNAL'/);
      expect(sql).toMatch(/'low'/);
      expect(values[1]).toBe('caus-1'); // correlation_id = causationEventId
      expect(values[5]).toBe(false);     // requires_manual_validation = false
    });

    it('cifra la ubicacion cuando lat/lng estan presentes', async () => {
      const deps = buildDeps();
      const client = buildClient();
      await createProgramarCoberturaHandler(deps)(client, payload);

      expect(deps.locationCrypto.encryptLocation).toHaveBeenCalledWith({
        latitude: -34.615,
        longitude: -58.371,
        address: 'Carnaval de San Telmo',
      });
      expect(client.query.mock.calls[0][1][3]).toBe('enc-loc');
    });

    it('requires_manual_validation=true y no cifra cuando faltan coordenadas', async () => {
      const deps = buildDeps();
      const client = buildClient();
      await createProgramarCoberturaHandler(deps)(client, { ...payload, latitud: null, longitud: null });

      expect(deps.locationCrypto.encryptLocation).not.toHaveBeenCalled();
      expect(client.query.mock.calls[0][1][3]).toBeNull(); // location_encrypted = null
      expect(client.query.mock.calls[0][1][5]).toBe(true);  // requires_manual_validation = true
    });

    it('inserta el evento en el outbox con el mismo client', async () => {
      const deps = buildDeps();
      const client = buildClient();
      await createProgramarCoberturaHandler(deps)(client, payload);

      expect(deps.emergencyRepository.insertOutboxEvent).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ topic: 'com.citypass.emergencias' }),
        expect.any(Object)
      );
    });

    it('la descripcion incluye el nombre y la capacidad', async () => {
      const deps = buildDeps();
      const client = buildClient();
      await createProgramarCoberturaHandler(deps)(client, payload);

      const description = client.query.mock.calls[0][1][4];
      expect(description).toContain('Carnaval de San Telmo');
      expect(description).toContain('2000');
    });

    it('falla si no viene causationEventId', async () => {
      const deps = buildDeps();
      const client = buildClient();
      await expect(
        createProgramarCoberturaHandler(deps)(client, { ...payload, causationEventId: undefined })
      ).rejects.toThrow(/causationEventId/);
    });
  });
});
