const { Disparador } = require('../../disparadores/disparador');
const { Respuesta } = require('../../disparadores/respuesta');
const { EventoPublicoDisparador } = require('../../disparadores/evento-publico');
const { ElevarPrioridad, MENSAJE } = require('../../disparadores/evento-publico/respuestas/elevar-prioridad');
const { crearRegistroDisparadores } = require('../../disparadores/registry');
const { EjecutarDisparadorCommand } = require('../../integracion/commands/ejecutar-disparador');

class RespuestaEspia extends Respuesta {
  constructor() {
    super();
    this.ejecutar = jest.fn(async () => {});
  }
}

describe('Disparador (template)', () => {
  it('no se puede instanciar la base', () => {
    expect(() => new Disparador()).toThrow(/abstracto/);
  });

  it('una subclase sin respuestas() lanza al responder', async () => {
    class SinRespuestas extends Disparador {}
    await expect(new SinRespuestas().responder({})).rejects.toThrow(/SinRespuestas debe definir respuestas/);
  });

  it('ejecuta cada respuesta con el ctx y las devuelve', async () => {
    const r1 = new RespuestaEspia();
    const r2 = new RespuestaEspia();
    class Dos extends Disparador {
      respuestas() { return [r1, r2]; }
    }
    const ctx = { client: {}, causationId: 'evt-1' };

    const ejecutadas = await new Dos().responder({ data: {} }, ctx);

    expect(ejecutadas).toEqual([r1, r2]);
    expect(r1.ejecutar).toHaveBeenCalledWith(ctx);
    expect(r2.ejecutar).toHaveBeenCalledWith(ctx);
  });

  it('si aplica() es falso no ejecuta ninguna respuesta', async () => {
    const r = new RespuestaEspia();
    class NoAplica extends Disparador {
      aplica() { return false; }
      respuestas() { return [r]; }
    }

    await expect(new NoAplica().responder({})).resolves.toEqual([]);
    expect(r.ejecutar).not.toHaveBeenCalled();
  });
});

describe('Respuesta (base)', () => {
  it('no se puede instanciar la base', () => {
    expect(() => new Respuesta()).toThrow(/abstracta/);
  });

  it('una subclase sin ejecutar() lanza', async () => {
    class SinEjecutar extends Respuesta {}
    await expect(new SinEjecutar().ejecutar({})).rejects.toThrow(/SinEjecutar debe definir ejecutar/);
  });
});

describe('EventoPublicoDisparador', () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  it('ante cualquier evento publico eleva la prioridad (mock)', async () => {
    const respuestas = await new EventoPublicoDisparador().responder({
      metadata: { eventId: 'evt-1' },
      data: { nombre: 'Feria', capacidad: 10 },
    });

    expect(respuestas).toHaveLength(1);
    expect(respuestas[0]).toBeInstanceOf(ElevarPrioridad);
    expect(logSpy).toHaveBeenCalledWith('Elevo Prioridad porque hay un evento');
    expect(MENSAJE).toBe('Elevo Prioridad porque hay un evento');
  });
});

describe('registro de disparadores', () => {
  it('resuelve EventoComunitarioPublicado al disparador de evento publico', () => {
    const registro = crearRegistroDisparadores();
    expect(registro.get('EventoComunitarioPublicado')).toBeInstanceOf(EventoPublicoDisparador);
  });
});

describe('EjecutarDisparadorCommand', () => {
  it('rechaza un disparador invalido', () => {
    expect(() => new EjecutarDisparadorCommand({ disparador: {} })).toThrow(/responder/);
  });

  it('delega en disparador.responder con el evento y el ctx', async () => {
    const disparador = { responder: jest.fn(async () => ['ok']) };
    const evento = { metadata: { eventId: 'e' }, data: {} };
    const ctx = { client: {}, causationId: 'e' };

    const result = await new EjecutarDisparadorCommand({ disparador, evento }).execute(ctx);

    expect(disparador.responder).toHaveBeenCalledWith(evento, ctx);
    expect(result).toEqual(['ok']);
  });
});
