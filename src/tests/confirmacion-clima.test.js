const { ConfirmarAlertaClimaticaRule } = require('../listeners/alerta-climatica/alerta-climatica-confirmada/rules/02-confirmar-alerta-climatica.rule');
const {
  PUBLICAR_CONFIRMACION_CLIMA,
  CONFIRMACION_CLIMA_EVENT_TYPE,
  confirmacionClimaTopic,
  createPublicarConfirmacionClimaHandler,
} = require('../listeners/alerta-climatica/handlers/confirmacion-clima.handler');
const { PUBLISHED_TYPES, GatewayPublisher } = require('../services/gateway-publisher');
const alertaClimatica = require('../listeners/alerta-climatica');

const ALERTA_ID = 'f6029e4f-e0ef-46b8-9f1a-66e814f1c90e';
const EVENT_ID = '3d9b2f6a-1c4e-4f8a-9b7d-2e5c8a1f4b60';

// Body real de Espacios (guía "CityPass Eventos climáticos", 13/11/2026).
const dataEspacios = () => ({
  alertaId: ALERTA_ID,
  nivelCriticidad: 'ALTA',
  fenomeno: 'OLA_DE_CALOR',
  ubicaciones: [{ latitud: -34.6037, longitud: -58.3816 }],
  barrios: ['BALVANERA', 'SAN NICOLAS'],
  vigenciaDesde: 1794603600000,
  vigenciaHasta: 1794625200000,
  temperaturaMinC: 28.0,
  temperaturaMaxC: 38.0,
  actorSub: 'admin-ejemplo',
});

describe('ConfirmarAlertaClimaticaRule', () => {
  const rule = new ConfirmarAlertaClimaticaRule();

  it('arma la confirmación con alertaId, NivelCriticidad y fenomeno', () => {
    const context = { data: dataEspacios(), metadata: { eventId: EVENT_ID } };
    expect(rule.appliesTo(context)).toBe(true);
    expect(rule.apply(context)).toEqual({
      type: PUBLICAR_CONFIRMACION_CLIMA,
      payload: { alertaId: ALERTA_ID, NivelCriticidad: 'ALTA', fenomeno: 'OLA_DE_CALOR', causationId: EVENT_ID },
    });
  });

  it('confirma aunque la criticidad no eleve la prioridad', () => {
    const context = { data: { ...dataEspacios(), nivelCriticidad: 'BAJA' }, metadata: {} };
    expect(rule.appliesTo(context)).toBe(true);
    expect(rule.apply(context).payload).toMatchObject({ NivelCriticidad: 'BAJA', causationId: null });
  });

  it('no confirma si falta alertaId, nivelCriticidad o fenomeno', () => {
    for (const cambio of [{ alertaId: 'no-uuid' }, { nivelCriticidad: '' }, { nivelCriticidad: undefined }, { fenomeno: '  ' }]) {
      expect(rule.appliesTo({ data: { ...dataEspacios(), ...cambio } })).toBe(false);
    }
    expect(rule.appliesTo({})).toBe(false);
  });
});

describe('createPublicarConfirmacionClimaHandler', () => {
  it('encola el evento en el outbox con el topic de Emergencias', async () => {
    const emergencyRepository = { insertOutboxEvent: jest.fn().mockResolvedValue() };
    const handler = createPublicarConfirmacionClimaHandler({ emergencyRepository });
    const client = {};

    await expect(handler(client, {
      alertaId: ALERTA_ID, NivelCriticidad: 'ALTA', fenomeno: 'OLA_DE_CALOR', causationId: EVENT_ID,
    })).resolves.toEqual({ applied: true });

    expect(emergencyRepository.insertOutboxEvent).toHaveBeenCalledWith(client, {
      topic: 'com.citypass.emergencias.CriticidadClimaticaConfirmada',
      payload: {
        type: 'CriticidadClimaticaConfirmada',
        correlationId: ALERTA_ID,
        causationId: EVENT_ID,
        data: { alertaId: ALERTA_ID, NivelCriticidad: 'ALTA', fenomeno: 'OLA_DE_CALOR' },
      },
    });
  });

  it('rechaza un payload incompleto y exige el repositorio', async () => {
    const handler = createPublicarConfirmacionClimaHandler({ emergencyRepository: { insertOutboxEvent: jest.fn() } });
    await expect(handler({}, { alertaId: ALERTA_ID })).rejects.toThrow(/alertaId, NivelCriticidad y fenomeno/);
    expect(() => createPublicarConfirmacionClimaHandler({})).toThrow(/emergencyRepository/);
  });

  it('el topic se pisa con TOPIC_CONFIRMACION_CLIMA', () => {
    expect(confirmacionClimaTopic({})).toBe('com.citypass.emergencias.CriticidadClimaticaConfirmada');
    expect(confirmacionClimaTopic({ TOPIC_CONFIRMACION_CLIMA: 'otro' })).toBe('otro');
  });
});

describe('publicación al gateway', () => {
  it('CriticidadClimaticaConfirmada sale al bus y POSTea solo data al FQN de Emergencias', async () => {
    expect(PUBLISHED_TYPES.has(CONFIRMACION_CLIMA_EVENT_TYPE)).toBe(true);

    const fetch = jest.fn().mockResolvedValue({
      status: 201, ok: true, json: async () => ({ metadata: { eventId: 'gw-1', payloadHash: 'h' } }),
    });
    const authClient = { getToken: jest.fn().mockResolvedValue('tok'), invalidate: jest.fn() };
    const publisher = new GatewayPublisher(authClient, { baseUrl: 'https://gw.test', fetch });
    const data = { alertaId: ALERTA_ID, NivelCriticidad: 'ALTA', fenomeno: 'OLA_DE_CALOR' };

    await publisher.publishEvent('ignorado', { type: 'CriticidadClimaticaConfirmada', data });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://gw.test/api/v1/event-types/${encodeURIComponent('com.citypass.emergencias.CriticidadClimaticaConfirmada')}/events`);
    expect(JSON.parse(init.body)).toEqual(data);
  });
});

describe('listener de alerta confirmada', () => {
  it('con el body real de Espacios devuelve el contexto de zona y la confirmación', async () => {
    const listener = new alertaClimatica.AlertaClimaticaConfirmadaListener({ consumer: jest.fn() });
    const outcomes = await listener.handle({ metadata: { eventId: EVENT_ID }, data: dataEspacios() });
    expect(outcomes.map((o) => o.type)).toEqual(['RegistrarContextoZona', PUBLICAR_CONFIRMACION_CLIMA]);
    expect(outcomes[1].payload).toMatchObject({ alertaId: ALERTA_ID, NivelCriticidad: 'ALTA', fenomeno: 'OLA_DE_CALOR' });
  });
});
