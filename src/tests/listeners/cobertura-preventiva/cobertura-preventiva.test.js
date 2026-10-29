jest.mock('../../../security/secure-log', () => ({ secureLog: jest.fn() }));

const { secureLog } = require('../../../security/secure-log');
const { EventListener, createListeners } = require('../../../listeners');
const {
  EventoComunitarioPublicadoListener,
  EventoCanceladoListener,
} = require('../../../listeners/cobertura-preventiva');

const kafka = { consumer: jest.fn() };

describe('listeners/cobertura-preventiva', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EDA_TOPIC_EVENTO_PUBLICADO = 'espacios.EventoComunitarioPublicado';
    process.env.EDA_TOPIC_EVENTO_CANCELADO = 'espacios.EventoCancelado';
  });

  afterAll(() => {
    process.env = env;
  });

  it('createListeners instancia los listeners de cada subpaquete', () => {
    const listeners = createListeners(kafka);
    expect(listeners.map((l) => l.constructor)).toEqual([
      EventoComunitarioPublicadoListener,
      EventoCanceladoListener,
    ]);
    listeners.forEach((l) => expect(l).toBeInstanceOf(EventListener));
  });

  it('EventoComunitarioPublicadoListener toma su topic del env', async () => {
    const listener = new EventoComunitarioPublicadoListener(kafka);
    expect(listener.topic).toBe('espacios.EventoComunitarioPublicado');

    await listener.handle({ metadata: { eventId: 'e1' }, data: { nombre: 'Recital', capacidad: 800 } });
    expect(secureLog).toHaveBeenCalledWith('info', 'EventoComunitarioPublicado recibido', {
      eventId: 'e1',
      nombre: 'Recital',
      capacidad: 800,
    });
  });

  it('EventoCanceladoListener toma su topic del env', async () => {
    const listener = new EventoCanceladoListener(kafka);
    expect(listener.topic).toBe('espacios.EventoCancelado');

    await listener.handle({ metadata: { eventId: 'e2', causationId: 'e1' } });
    expect(secureLog).toHaveBeenCalledWith('info', 'EventoCancelado recibido', {
      eventId: 'e2',
      causationId: 'e1',
    });
  });

  it('los handlers toleran eventos sin metadata/data', async () => {
    await expect(new EventoComunitarioPublicadoListener(kafka).handle(null)).resolves.toBeUndefined();
    await expect(new EventoCanceladoListener(kafka).handle(undefined)).resolves.toBeUndefined();
  });

  it('options.topic pisa el del env', () => {
    expect(new EventoCanceladoListener(kafka, { topic: 'otro' }).topic).toBe('otro');
  });
});
