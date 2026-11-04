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

  it('EventoComunitarioPublicadoListener toma su topic del env', () => {
    expect(new EventoComunitarioPublicadoListener(kafka).topic).toBe('espacios.EventoComunitarioPublicado');
  });

  it('EventoCanceladoListener toma su topic del env', () => {
    expect(new EventoCanceladoListener(kafka).topic).toBe('espacios.EventoCancelado');
  });

  it('cada listener carga las reglas de su carpeta rules/', () => {
    const path = require('path');
    const base = path.join(__dirname, '../../../listeners/cobertura-preventiva');
    expect(new EventoComunitarioPublicadoListener(kafka).rulesDir).toBe(path.join(base, 'evento-comunitario-publicado', 'rules'));
    expect(new EventoCanceladoListener(kafka).rulesDir).toBe(path.join(base, 'evento-cancelado', 'rules'));
  });

  it('EventoComunitarioPublicadoListener dispara ProgramarCobertura cuando capacidad >= umbral', async () => {
    const evento = { metadata: { eventId: 'e1' }, data: { nombre: 'Recital', capacidad: 800 } };
    const outcomes = await new EventoComunitarioPublicadoListener(kafka).handle(evento);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].type).toBe('ProgramarCobertura');
  });

  it('EventoComunitarioPublicadoListener no dispara cuando capacidad < umbral', async () => {
    const evento = { metadata: { eventId: 'e2' }, data: { nombre: 'Reunion pequena', capacidad: 10 } };
    const outcomes = await new EventoComunitarioPublicadoListener(kafka).handle(evento);
    expect(outcomes).toEqual([]);
  });

  it('EventoCanceladoListener aun no tiene reglas: procesa sin resultados', async () => {
    const evento = { metadata: { eventId: 'e1' }, data: { nombre: 'Recital', capacidad: 800 } };
    await expect(new EventoCanceladoListener(kafka).handle(evento)).resolves.toEqual([]);
    expect(secureLog).toHaveBeenCalledWith('info', 'EventoCanceladoListener proceso evento', {
      eventId: 'e1',
      outcomes: [],
    });
  });

  it('options.topic pisa el del env', () => {
    expect(new EventoCanceladoListener(kafka, { topic: 'otro' }).topic).toBe('otro');
  });
});
