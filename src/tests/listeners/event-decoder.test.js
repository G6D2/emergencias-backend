const { createEventDecoder, registryFromEnv } = require('../../listeners/event-decoder');

// Mensaje en formato Confluent: [0x00][schemaId: 4 bytes][Avro binario].
function confluentMessage(schemaId, payload = Buffer.from([1, 2, 3])) {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeInt32BE(schemaId, 1);
  return Buffer.concat([header, payload]);
}

describe('createEventDecoder', () => {
  it('decodifica Avro contra el registry', async () => {
    const event = { metadata: { eventId: 'e1' }, data: { eventoId: 'ev-1' } };
    const registry = { decode: jest.fn().mockResolvedValue(event) };
    const message = confluentMessage(28);

    await expect(createEventDecoder({ registry }).decode(message)).resolves.toEqual(event);
    expect(registry.decode).toHaveBeenCalledWith(message);
  });

  it('lee JSON si el mensaje no empieza con 0x00', async () => {
    const event = { metadata: { eventId: 'e1' }, data: {} };
    await expect(createEventDecoder().decode(Buffer.from(JSON.stringify(event)))).resolves.toEqual(event);
  });

  it('JSON inválido o mensaje vacío son errores permanentes', async () => {
    const decoder = createEventDecoder();
    await expect(decoder.decode(Buffer.from('{no'))).rejects.toMatchObject({ permanent: true });
    await expect(decoder.decode(Buffer.alloc(0))).rejects.toMatchObject({ permanent: true });
    await expect(decoder.decode(null)).rejects.toMatchObject({ permanent: true });
  });

  it('Avro sin registry configurado es permanente', async () => {
    await expect(createEventDecoder().decode(confluentMessage(1))).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/EDA_SCHEMA_REGISTRY_URL/),
    });
  });

  it('un payload que no matchea su schema es permanente', async () => {
    const registry = { decode: jest.fn().mockRejectedValue(new Error('truncated buffer')) };
    await expect(createEventDecoder({ registry }).decode(confluentMessage(1))).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/Avro inválido/),
    });
  });

  it('un schema inexistente (404) es permanente', async () => {
    const registry = { decode: jest.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 })) };
    await expect(createEventDecoder({ registry }).decode(confluentMessage(9))).rejects.toMatchObject({ permanent: true });
  });

  it('el registry caído, saturado o sin permisos es transitorio', async () => {
    for (const error of [
      Object.assign(new Error('Error, status 503'), { status: 503 }),
      Object.assign(new Error('Error, status 429'), { status: 429 }),
      Object.assign(new Error('Error, status 401'), { status: 401 }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ]) {
      const registry = { decode: jest.fn().mockRejectedValue(error) };
      await expect(createEventDecoder({ registry }).decode(confluentMessage(1))).rejects.toMatchObject({ transient: true });
    }
  });
});

describe('registryFromEnv', () => {
  it('sin EDA_SCHEMA_REGISTRY_URL no hay registry', () => {
    expect(registryFromEnv({})).toBeNull();
  });

  it('con URL arma el registry del gateway', () => {
    const registry = registryFromEnv({ EDA_SCHEMA_REGISTRY_URL: 'http://localhost:8080/api/v1' });
    expect(typeof registry.decode).toBe('function');
  });

  it('acepta credenciales opcionales', () => {
    const registry = registryFromEnv({
      EDA_SCHEMA_REGISTRY_URL: 'http://localhost:8080/api/v1',
      EDA_SCHEMA_REGISTRY_USERNAME: 'u',
      EDA_SCHEMA_REGISTRY_PASSWORD: 'p',
    });
    expect(typeof registry.decode).toBe('function');
  });
});
