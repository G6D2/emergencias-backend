// Test de arquitectura (ADR "Consumir todos los eventos externos con un solo
// consumer"). El EventConsumer único no arranca si dos listeners comparten un
// tópico, y si no arranca se caen todos los listeners. Este test arma todos
// los listeners con todos los tópicos cargados, como en producción con todo
// prendido, y arranca el consumer: falla si alguien suma un segundo listener
// en un tópico que ya tiene dueño (por ejemplo, otra implementación de la
// alerta climática de Espacios) o un tópico por default para la alerta, que
// es opt-in.

jest.mock('../../security/secure-log', () => ({ secureLog: jest.fn() }));

const { createListeners } = require('../../listeners');
const { EventConsumer } = require('../../listeners/event-consumer');
const {
  CriticidadClimaticaConfirmadaListener,
  CriticidadClimaticaFinalizadaListener,
} = require('../../listeners/alerta-climatica');

const CONFIRMADA = 'com.citypass.espacios.CriticidadClimaticaConfirmada';
const FINALIZADA = 'com.citypass.espacios.CriticidadClimaticaFinalizada';

// Tópicos de todos los listeners, con los nombres del catálogo del gateway.
// Los que tienen default en el código también se cargan, por si alguien lo
// pisa con el mismo nombre que otro.
const TOPICOS = {
  EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA: CONFIRMADA,
  EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA: FINALIZADA,
  EDA_TOPIC_EVENTO_PUBLICADO: 'com.citypass.espacios.EventoComunitarioPublicado',
  EDA_TOPIC_EVENTO_CANCELADO: 'com.citypass.espacios.EventoCancelado',
  EDA_TOPIC_RESERVA_CREADA: 'com.citypass.espacios.ReservaCreada',
};
// Variables de la versión anterior de la alerta (PR #121, por barrios). Ya
// no las lee nadie: cargadas no tienen que sumar listeners.
const VARIABLES_VIEJAS = {
  EDA_TOPIC_ALERTA_CLIMATICA_CONFIRMADA: CONFIRMADA,
  EDA_TOPIC_ALERTA_CLIMATICA_FINALIZADA: FINALIZADA,
};

function buildKafka() {
  const consumer = {
    events: { FETCH_START: 'consumer.fetch_start', CRASH: 'consumer.crash' },
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { consumer, kafka: { consumer: jest.fn(() => consumer) } };
}

describe('arquitectura: un listener por tópico', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('con todos los tópicos cargados, el EventConsumer arranca y se suscribe una vez a cada uno', async () => {
    Object.assign(process.env, TOPICOS, VARIABLES_VIEJAS);
    const { consumer, kafka } = buildKafka();
    const listeners = createListeners(kafka);

    const eventConsumer = new EventConsumer(kafka, listeners);
    await eventConsumer.start();

    const suscriptos = consumer.subscribe.mock.calls.map(([{ topic }]) => topic);
    expect(new Set(suscriptos).size).toBe(suscriptos.length);
    expect(suscriptos).toEqual(expect.arrayContaining(Object.values(TOPICOS)));
    expect(kafka.consumer).toHaveBeenCalledTimes(1);
    await eventConsumer.stop();
  });

  it('cada tópico de la alerta climática tiene un solo listener: los del ADR #39', () => {
    Object.assign(process.env, TOPICOS, VARIABLES_VIEJAS);
    const listeners = createListeners(buildKafka().kafka);

    const deConfirmada = listeners.filter((l) => l.topic === CONFIRMADA);
    const deFinalizada = listeners.filter((l) => l.topic === FINALIZADA);
    expect(deConfirmada.map((l) => l.constructor)).toEqual([CriticidadClimaticaConfirmadaListener]);
    expect(deFinalizada.map((l) => l.constructor)).toEqual([CriticidadClimaticaFinalizadaListener]);
  });

  it('sin las variables, nadie escucha la alerta climática (es opt-in, sin default)', () => {
    for (const name of [...Object.keys(TOPICOS), ...Object.keys(VARIABLES_VIEJAS)]) delete process.env[name];
    const listeners = createListeners(buildKafka().kafka);

    expect(listeners.filter((l) => typeof l.topic === 'string' && l.topic.includes('CriticidadClimatica'))).toEqual([]);
  });

  it('ningún tópico configurado se repite entre listeners', () => {
    Object.assign(process.env, TOPICOS, VARIABLES_VIEJAS);
    const topics = createListeners(buildKafka().kafka).map((l) => l.topic).filter(Boolean);

    expect(new Set(topics).size).toBe(topics.length);
  });
});
