const { ProgramarCoberturaPreventivaCommand } = require('../../integracion/commands/programar-cobertura-preventiva');

describe('ProgramarCoberturaPreventivaCommand', () => {
  const makeClient = () => ({ query: jest.fn().mockResolvedValue({ rowCount: 1 }) });
  const makeLocationCrypto = () => ({
    encryptLocation: jest.fn().mockReturnValue('cipher-abc'),
  });

  it('rechaza construccion sin causationEventId', () => {
    expect(() => new ProgramarCoberturaPreventivaCommand({
      locationCrypto: makeLocationCrypto(),
    })).toThrow(/causationEventId/);
  });

  it('rechaza construccion sin locationCrypto', () => {
    expect(() => new ProgramarCoberturaPreventivaCommand({
      causationEventId: 'evt-1',
    })).toThrow(/locationCrypto/);
  });

  it('requiresManualValidation = true si falta lat o lng', () => {
    const base = { causationEventId: 'e', locationCrypto: makeLocationCrypto() };
    expect(new ProgramarCoberturaPreventivaCommand({ ...base }).requiresManualValidation()).toBe(true);
    expect(new ProgramarCoberturaPreventivaCommand({ ...base, latitud: -34.6 }).requiresManualValidation()).toBe(true);
    expect(new ProgramarCoberturaPreventivaCommand({ ...base, latitud: -34.6, longitud: -58.4 }).requiresManualValidation()).toBe(false);
  });

  it('inserta emergencia con lat/lng cifradas cuando vienen', async () => {
    const client = makeClient();
    const locationCrypto = makeLocationCrypto();
    const cmd = new ProgramarCoberturaPreventivaCommand({
      nombre: 'Feria',
      latitud: -34.6,
      longitud: -58.4,
      capacidad: 600,
      causationEventId: 'evt-123',
      locationCrypto,
    });

    const result = await cmd.execute({ client });

    expect(locationCrypto.encryptLocation).toHaveBeenCalledWith({
      latitude: -34.6,
      longitude: -58.4,
      address: 'Feria',
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO emergencies/);
    expect(sql).toMatch(/'EXTERNAL'/);
    expect(sql).toMatch(/'DISTURBIO_EVENTO_MASIVO'/);
    expect(sql).toMatch(/'PENDING'/);
    expect(sql).toMatch(/'baja'/);
    // id, correlation_id, user_id, location_encrypted, description, requires_manual_validation
    expect(params[1]).toBe('evt-123'); // correlation_id
    expect(params[2]).toBe('eda-bus'); // user_id default
    expect(params[3]).toBe('cipher-abc'); // location_encrypted
    expect(params[4]).toMatch(/Feria/);
    expect(params[4]).toMatch(/600 asistentes/);
    expect(params[5]).toBe(false); // requires_manual_validation
    expect(result).toEqual({ emergencyId: expect.any(String), requiresManual: false });
  });

  it('inserta sin cifrado y marca manual si falta lat/lng', async () => {
    const client = makeClient();
    const locationCrypto = makeLocationCrypto();
    const cmd = new ProgramarCoberturaPreventivaCommand({
      nombre: 'Parque sin coords',
      capacidad: 800,
      causationEventId: 'evt-xyz',
      locationCrypto,
    });

    const result = await cmd.execute({ client });

    expect(locationCrypto.encryptLocation).not.toHaveBeenCalled();
    const [, params] = client.query.mock.calls[0];
    expect(params[3]).toBeNull(); // location_encrypted
    expect(params[5]).toBe(true); // requires_manual_validation
    expect(result.requiresManual).toBe(true);
  });

  it('descripcion omite "N asistentes" si capacidad no viene', async () => {
    const client = makeClient();
    const cmd = new ProgramarCoberturaPreventivaCommand({
      nombre: 'Feria sin capacidad',
      latitud: -34.6,
      longitud: -58.4,
      causationEventId: 'e',
      locationCrypto: makeLocationCrypto(),
    });
    await cmd.execute({ client });
    const [, params] = client.query.mock.calls[0];
    expect(params[4]).toBe('Cobertura preventiva — Feria sin capacidad');
  });

  it('userIdForExternal se puede override', async () => {
    const client = makeClient();
    const cmd = new ProgramarCoberturaPreventivaCommand({
      nombre: 'X',
      latitud: 0,
      longitud: 0,
      causationEventId: 'e',
      locationCrypto: makeLocationCrypto(),
      userIdForExternal: 'otro-system',
    });
    await cmd.execute({ client });
    expect(client.query.mock.calls[0][1][2]).toBe('otro-system');
  });

  it('execute sin client lanza', async () => {
    const cmd = new ProgramarCoberturaPreventivaCommand({
      causationEventId: 'e',
      locationCrypto: makeLocationCrypto(),
    });
    await expect(cmd.execute({})).rejects.toThrow(/ctx.client/);
  });

  it('nombre default es "Evento comunitario"', () => {
    const cmd = new ProgramarCoberturaPreventivaCommand({
      causationEventId: 'e',
      locationCrypto: makeLocationCrypto(),
    });
    expect(cmd.nombre).toBe('Evento comunitario');
  });
});
