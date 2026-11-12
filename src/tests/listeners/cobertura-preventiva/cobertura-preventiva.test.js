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
    expect(listeners.map((l) => l.constructor).slice(0, 2)).toEqual([
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

  describe('ActividadCreada (forma actual de Espacios)', () => {
    // Mensaje real recibido del gateway.
    const actividadCreada = (data = {}) => ({
      data: {
        correlationId: 'act-f737df56-d0b8-4727-b024-6479f87da978',
        actividadId: 'f737df56-d0b8-4727-b024-6479f87da978',
        titulo: 'Prueba hipo',
        estado: 'PROGRAMADA',
        capacidad: 100,
        fechaHoraInicio: 1794690000000,
        fechaHoraFinalizacion: 1794697200000,
        ubicacion: { lat: -34.617126, lng: -58.3817043 },
        direccion: 'Lima 757',
        espacioNombre: 'Uade',
        actorSub: 'U000009',
        categoria: 'Arte',
        ...data,
      },
      metadata: {
        eventId: 'cb9f8f09-d5c7-490c-b5c7-cf9ad3e64b6d',
        eventType: 'com.citypass.espacios.ActividadCreada',
        receivedAt: 1794525836493,
        source: 'grupo7',
      },
    });

    it('registra el contexto de zona con el punto y la ventana de la actividad', async () => {
      const outcomes = await new EventoComunitarioPublicadoListener(kafka).handle(actividadCreada());
      expect(outcomes.map((o) => o.type)).toEqual(['RegistrarContextoZona']);
      const { payload } = outcomes[0];
      expect(payload).toMatchObject({
        tipo: 'EVENTO_ESPACIO_PUBLICO',
        origen: 'espacios',
        referenciaExterna: 'f737df56-d0b8-4727-b024-6479f87da978',
        causationId: 'cb9f8f09-d5c7-490c-b5c7-cf9ad3e64b6d',
        latitud: -34.617126,
        longitud: -58.3817043,
        ventanaPorDefecto: false,
        suspendido: false,
        descripcion: 'Prueba hipo',
      });
      expect(payload.vigenteDesde).toEqual(new Date(1794690000000));
      expect(payload.vigenteHasta).toEqual(new Date(1794697200000));
      expect(payload.sourceUpdatedAt).toEqual(new Date(1794525836493));
    });

    it('con capacidad >= umbral programa la cobertura con el actividadId y la ubicación', async () => {
      const outcomes = await new EventoComunitarioPublicadoListener(kafka).handle(actividadCreada({ capacidad: 800 }));
      expect(outcomes.map((o) => o.type)).toEqual(['ProgramarCobertura', 'RegistrarContextoZona']);
      expect(outcomes[0].payload).toMatchObject({
        eventoId: 'f737df56-d0b8-4727-b024-6479f87da978',
        titulo: 'Prueba hipo',
        latitud: -34.617126,
        longitud: -58.3817043,
        direccion: 'Lima 757',
        capacidad: 800,
        correlationId: 'act-f737df56-d0b8-4727-b024-6479f87da978',
      });
    });

    it('la cancelación acepta actividadId', async () => {
      const evento = { metadata: { eventId: 'e4' }, data: { actividadId: 'act-1' } };
      const outcomes = await new EventoCanceladoListener(kafka).handle(evento);
      expect(outcomes[0]).toEqual({ type: 'CancelarCobertura', payload: { eventoId: 'act-1' } });
      expect(outcomes[1].payload.referenciaExterna).toBe('act-1');
    });
  });

  it('options.topic pisa el del env', () => {
    expect(new EventoCanceladoListener(kafka, { topic: 'otro' }).topic).toBe('otro');
  });
});
