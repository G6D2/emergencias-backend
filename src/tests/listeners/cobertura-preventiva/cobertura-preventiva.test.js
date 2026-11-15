jest.mock('../../../security/secure-log', () => ({ secureLog: jest.fn() }));

const { secureLog } = require('../../../security/secure-log');
const { EventListener, createListeners } = require('../../../listeners');
const {
  EventoComunitarioPublicadoListener,
  EventoCanceladoListener,
  ActividadCreadaListener,
} = require('../../../listeners/cobertura-preventiva');

const kafka = { consumer: jest.fn() };

describe('listeners/cobertura-preventiva', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EDA_TOPIC_EVENTO_PUBLICADO = 'espacios.EventoComunitarioPublicado';
    process.env.EDA_TOPIC_EVENTO_CANCELADO = 'espacios.EventoCancelado';
    process.env.EDA_TOPIC_ACTIVIDAD_CREADA = 'espacios.ActividadCreada.v3';
  });

  afterAll(() => {
    process.env = env;
  });

  it('createListeners instancia los listeners de cada subpaquete', () => {
    const listeners = createListeners(kafka);
    expect(listeners.map((l) => l.constructor).slice(0, 3)).toEqual([
      EventoComunitarioPublicadoListener,
      EventoCanceladoListener,
      ActividadCreadaListener,
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
    const evento = { metadata: { eventId: 'e1' }, data: { eventoId: 'ev-1', titulo: 'Recital', capacidad: 800 } };
    const outcomes = await new EventoComunitarioPublicadoListener(kafka).handle(evento);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].type).toBe('ProgramarCobertura');
  });

  it('EventoCanceladoListener dispara CancelarCobertura con el eventoId', async () => {
    const evento = { metadata: { eventId: 'e3' }, data: { eventoId: 'ev-1', motivo: 'lluvia' } };
    const outcomes = await new EventoCanceladoListener(kafka).handle(evento);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toEqual({ type: 'CancelarCobertura', payload: { eventoId: 'ev-1' } });
    expect(outcomes[1].type).toBe('DarDeBajaContextoZona');
  });

  it('EventoComunitarioPublicadoListener no dispara cuando capacidad < umbral', async () => {
    const evento = { metadata: { eventId: 'e2' }, data: { eventoId: 'ev-2', titulo: 'Reunion pequena', capacidad: 10 } };
    const outcomes = await new EventoComunitarioPublicadoListener(kafka).handle(evento);
    expect(outcomes).toEqual([]);
  });

  it('EventoCanceladoListener sin eventoId procesa sin resultados', async () => {
    const evento = { metadata: { eventId: 'e1' }, data: { nombre: 'Recital', capacidad: 800 } };
    await expect(new EventoCanceladoListener(kafka).handle(evento)).resolves.toEqual([]);
    expect(secureLog).toHaveBeenCalledWith('info', 'EventoCanceladoListener proceso evento', {
      eventId: 'e1',
      outcomes: [],
    });
  });

  it('ActividadCreadaListener toma su topic del env y carga sus reglas', () => {
    const path = require('path');
    const listener = new ActividadCreadaListener(kafka);
    expect(listener.topic).toBe('espacios.ActividadCreada.v3');
    expect(listener.rulesDir).toBe(
      path.join(__dirname, '../../../listeners/cobertura-preventiva', 'actividad-creada', 'rules')
    );
    expect(listener.rules()).toHaveLength(1);
  });

  it('ActividadCreadaListener dispara ProgramarCobertura con el actividadId como eventoId', async () => {
    const evento = {
      metadata: { eventId: 'e4' },
      data: {
        actividadId: 'act-1',
        titulo: 'Festival',
        capacidad: 1200,
        estado: 'PROGRAMADA',
        ubicacion: { lat: -34.5994, lng: -58.3988 },
      },
    };
    const outcomes = await new ActividadCreadaListener(kafka).handle(evento);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].type).toBe('ProgramarCobertura');
    expect(outcomes[0].payload).toMatchObject({ eventoId: 'act-1', latitud: -34.5994, longitud: -58.3988 });
  });

  it('ActividadCreadaListener no dispara por debajo del umbral de 1.000', async () => {
    const evento = { metadata: { eventId: 'e5' }, data: { actividadId: 'act-2', capacidad: 999 } };
    await expect(new ActividadCreadaListener(kafka).handle(evento)).resolves.toEqual([]);
  });

  it('options.topic pisa el del env', () => {
    expect(new EventoCanceladoListener(kafka, { topic: 'otro' }).topic).toBe('otro');
  });
});
