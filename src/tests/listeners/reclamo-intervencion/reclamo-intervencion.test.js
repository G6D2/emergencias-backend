jest.mock('../../../security/secure-log', () => ({ secureLog: jest.fn() }));

const path = require('path');
const { EventListener, createListeners } = require('../../../listeners');
const {
  EmergenciaSolicitadaListener,
  ReclamoCreadoListener,
  ReclamoActualizadoListener,
} = require('../../../listeners/reclamo-intervencion');
const { CrearIntervencionPorSolicitudRule } = require('../../../listeners/reclamo-intervencion/emergencia-solicitada/rules/01-crear-intervencion.rule');
const { CrearIntervencionPorReclamoRule } = require('../../../listeners/reclamo-intervencion/reclamo-creado/rules/01-crear-intervencion.rule');
const { CerrarIntervencionPorReclamoRule } = require('../../../listeners/reclamo-intervencion/reclamo-actualizado/rules/01-cerrar-intervencion.rule');

const kafka = { consumer: jest.fn() };

// Forma del ReclamoCreado v3 de Reclamos (docs/avro/ReclamoCreado.avsc).
const RECLAMO = {
  reclamoId: 'rec-123',
  ciudadanoId: 'vec-9',
  canal: 'APP',
  titulo: 'Auto estacionado en la bicisenda',
  descripcion: 'Hace dos horas que está ahí',
  categoria: 'TRANSITO',
  prioridad: 'ALTA',
  estado: 'RECIBIDO',
  origenClasificacion: 'CIUDADANO',
  direccion: 'Av. Corrientes 1234',
  barrio: 'San Nicolás',
  latitud: -34.6037,
  longitud: -58.3816,
  objetoAfectado: 'CICLOVIA',
  afectaCirculacion: true,
  correlationId: '0d9f7f0e-5a52-4f5e-9a55-2f6f0c1f3a10',
  createdAt: 1794500000000,
};

describe('listeners/reclamo-intervencion', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('createListeners suma los tres listeners del paquete', () => {
    const constructors = createListeners(kafka).map((l) => l.constructor);
    expect(constructors).toEqual(expect.arrayContaining([
      EmergenciaSolicitadaListener, ReclamoCreadoListener, ReclamoActualizadoListener,
    ]));
  });

  it('sin variables de entorno escuchan los tópicos vigentes de Reclamos y de Movilidad', () => {
    delete process.env.EDA_TOPIC_RECLAMO_CREADO;
    delete process.env.EDA_TOPIC_RECLAMO_ACTUALIZADO;
    delete process.env.EDA_TOPIC_EMERGENCIA_SOLICITADA;
    expect(new EmergenciaSolicitadaListener(kafka).topic).toBe('com.citypass.movilidad.EmergenciaSolicitada');
    expect(new ReclamoCreadoListener(kafka).topic).toBe('com.citypass.reclamos.ReclamoCreado.v3');
    expect(new ReclamoActualizadoListener(kafka).topic).toBe('com.citypass.reclamos.ReclamoActualizado');
  });

  it('el tópico se puede cambiar por env (otra versión del tipo)', () => {
    process.env.EDA_TOPIC_RECLAMO_CREADO = 'com.citypass.reclamos.ReclamoCreado.v4';
    process.env.EDA_TOPIC_RECLAMO_ACTUALIZADO = 'otro.ReclamoActualizado';
    process.env.EDA_TOPIC_EMERGENCIA_SOLICITADA = 'otro.EmergenciaSolicitada';
    expect(new EmergenciaSolicitadaListener(kafka).topic).toBe('otro.EmergenciaSolicitada');
    expect(new ReclamoCreadoListener(kafka).topic).toBe('com.citypass.reclamos.ReclamoCreado.v4');
    expect(new ReclamoActualizadoListener(kafka).topic).toBe('otro.ReclamoActualizado');
  });

  it('son EventListener con reglas en su carpeta', () => {
    const base = path.join(__dirname, '../../../listeners/reclamo-intervencion');
    const creado = new ReclamoCreadoListener(kafka);
    const actualizado = new ReclamoActualizadoListener(kafka);
    expect(creado).toBeInstanceOf(EventListener);
    expect(creado.rulesDir).toBe(path.join(base, 'reclamo-creado', 'rules'));
    expect(actualizado.rulesDir).toBe(path.join(base, 'reclamo-actualizado', 'rules'));
    expect(creado.rules().map((r) => r.constructor)).toEqual([CrearIntervencionPorReclamoRule]);
    expect(actualizado.rules().map((r) => r.constructor)).toEqual([CerrarIntervencionPorReclamoRule]);

    const solicitada = new EmergenciaSolicitadaListener(kafka);
    expect(solicitada).toBeInstanceOf(EventListener);
    expect(solicitada.rulesDir).toBe(path.join(base, 'emergencia-solicitada', 'rules'));
    expect(solicitada.rules().map((r) => r.constructor)).toEqual([CrearIntervencionPorSolicitudRule]);
  });

  describe('RECLAMO_INTERVENCION_DISPARADOR', () => {
    const RECLAMO_DE_CICLOVIA = { ...RECLAMO };
    const SOLICITUD = { reclamoId: 'rec-123', prioridad: 'ALTA', latitud: -34.6037, longitud: -58.3816 };
    const aplican = (options) => ({
      reclamo: new ReclamoCreadoListener(kafka, options),
      movilidad: new EmergenciaSolicitadaListener(kafka, options),
    });
    const outcomes = async (listener, data) => {
      const context = listener.buildContext({ metadata: { eventId: 'e-1' }, data });
      const rule = listener.rules()[0];
      return (await rule.appliesTo(context)) ? [rule.apply(context).type] : [];
    };

    it('default (movilidad): crea la EmergenciaSolicitada; un ReclamoCreado solo no crea nada', async () => {
      delete process.env.RECLAMO_INTERVENCION_DISPARADOR;
      const { reclamo, movilidad } = aplican();
      expect(reclamo.disparador).toBe('movilidad');
      expect(await outcomes(movilidad, SOLICITUD)).toEqual(['CrearIntervencionPorReclamo']);
      expect(await outcomes(reclamo, RECLAMO_DE_CICLOVIA)).toEqual([]);
    });

    it('reclamo: solo el ReclamoCreado crea (comportamiento anterior)', async () => {
      process.env.RECLAMO_INTERVENCION_DISPARADOR = 'reclamo';
      const { reclamo, movilidad } = aplican();
      expect(await outcomes(reclamo, RECLAMO_DE_CICLOVIA)).toEqual(['CrearIntervencionPorReclamo']);
      expect(await outcomes(movilidad, SOLICITUD)).toEqual([]);
    });

    it('ambos: cualquiera de los dos crea; mayúsculas y espacios no importan', async () => {
      process.env.RECLAMO_INTERVENCION_DISPARADOR = ' Ambos ';
      const { reclamo, movilidad } = aplican();
      expect(await outcomes(reclamo, RECLAMO_DE_CICLOVIA)).toEqual(['CrearIntervencionPorReclamo']);
      expect(await outcomes(movilidad, SOLICITUD)).toEqual(['CrearIntervencionPorReclamo']);
    });

    it('options.disparador pisa la variable de entorno', async () => {
      process.env.RECLAMO_INTERVENCION_DISPARADOR = 'reclamo';
      const { movilidad } = aplican({ disparador: 'movilidad' });
      expect(await outcomes(movilidad, SOLICITUD)).toEqual(['CrearIntervencionPorReclamo']);
    });

    it('un valor que no existe frena el arranque en vez de apagar el plan B en silencio', () => {
      process.env.RECLAMO_INTERVENCION_DISPARADOR = 'anbos';
      expect(() => new ReclamoCreadoListener(kafka)).toThrow(/RECLAMO_INTERVENCION_DISPARADOR/);
      expect(() => new EmergenciaSolicitadaListener(kafka)).toThrow(/RECLAMO_INTERVENCION_DISPARADOR/);
    });
  });

  describe('CrearIntervencionPorSolicitudRule (EmergenciaSolicitada de Movilidad)', () => {
    const rule = new CrearIntervencionPorSolicitudRule();
    // Forma del EmergenciaSolicitada del PR #40 de Movilidad.
    const SOLICITUD = {
      reclamoId: 'rec-123',
      correlationId: '0d9f7f0e-5a52-4f5e-9a55-2f6f0c1f3a10',
      origen: 'MOVILIDAD',
      tipoEmergencia: 'OBSTRUCCION_CICLOVIA_CRITICA',
      prioridad: 'CRITICA',
      descripcion: 'Obstrucción crítica de ciclovía con 3 estaciones afectadas',
      direccion: 'Av. Corrientes 1234',
      latitud: -34.6037,
      longitud: -58.3816,
      solicitadoAt: 1794528000000,
    };
    const applies = (overrides, disparador = 'movilidad') => rule.appliesTo({ data: { ...SOLICITUD, ...overrides }, disparador });

    it('aplica a una solicitud con reclamoId', () => {
      expect(applies({})).toBe(true);
      expect(applies({}, 'ambos')).toBe(true);
    });

    it('no aplica sin reclamoId, ni con el disparador en reclamo', () => {
      expect(applies({ reclamoId: '' })).toBe(false);
      expect(applies({ reclamoId: '   ' })).toBe(false);
      expect(applies({ reclamoId: 42 })).toBe(false);
      expect(applies({}, 'reclamo')).toBe(false);
      expect(rule.appliesTo({ disparador: 'movilidad' })).toBe(false);
    });

    it('arma el mismo outcome que el reclamo directo, con la descripción de Movilidad como título', () => {
      expect(rule.apply({ data: SOLICITUD })).toEqual({
        type: 'CrearIntervencionPorReclamo',
        payload: {
          reclamoId: 'rec-123',
          titulo: 'Obstrucción crítica de ciclovía con 3 estaciones afectadas',
          prioridad: 'CRITICA',
          latitud: -34.6037,
          longitud: -58.3816,
          direccion: 'Av. Corrientes 1234',
          barrio: null,
          correlationId: '0d9f7f0e-5a52-4f5e-9a55-2f6f0c1f3a10',
        },
      });
    });

    it('recorta una descripción larga y tolera opcionales ausentes o de otro tipo', () => {
      const largo = rule.apply({ data: { ...SOLICITUD, descripcion: 'x'.repeat(500) } });
      expect(largo.payload.titulo).toHaveLength(160);

      const { payload } = rule.apply({ data: { reclamoId: 'rec-1', latitud: '-34.6', descripcion: '   ' } });
      expect(payload).toEqual({
        reclamoId: 'rec-1', titulo: null, prioridad: null, latitud: null, longitud: null,
        direccion: null, barrio: null, correlationId: null,
      });
    });
  });

  describe('CrearIntervencionPorReclamoRule', () => {
    const rule = new CrearIntervencionPorReclamoRule();
    // Regla del plan B: solo aplica con el disparador en reclamo o ambos.
    const applies = (overrides, disparador = 'reclamo') => rule.appliesTo({ data: { ...RECLAMO, ...overrides }, disparador });

    it('aplica a un reclamo de tránsito sobre una ciclovía', () => {
      expect(applies({})).toBe(true);
      expect(applies({}, 'ambos')).toBe(true);
    });

    it('con el disparador por defecto (movilidad) no aplica', () => {
      expect(applies({}, 'movilidad')).toBe(false);
      expect(applies({}, undefined)).toBe(true); // el default del helper es reclamo
      expect(rule.appliesTo({ data: RECLAMO })).toBe(false);
    });

    it('tolera mayúsculas, acento y espacios en categoría y objeto', () => {
      expect(applies({ categoria: 'transito', objetoAfectado: ' Ciclovía ' })).toBe(true);
      expect(applies({ categoria: 'Tránsito' })).toBe(true);
    });

    it('no aplica a otra categoría ni a otro objeto', () => {
      expect(applies({ categoria: 'BACHES' })).toBe(false);
      expect(applies({ objetoAfectado: 'VEREDA' })).toBe(false);
    });

    it('no aplica si el vecino no cargó el objeto afectado', () => {
      expect(applies({ objetoAfectado: null })).toBe(false);
      expect(applies({ objetoAfectado: undefined })).toBe(false);
    });

    it('no aplica sin reclamoId ni con un reclamo que ya terminó', () => {
      expect(applies({ reclamoId: '' })).toBe(false);
      expect(applies({ reclamoId: 42 })).toBe(false);
      expect(applies({ estado: 'RESUELTO' })).toBe(false);
      expect(applies({ estado: 'rechazado' })).toBe(false);
      expect(applies({ estado: 'CERRADO' })).toBe(false);
      expect(rule.appliesTo({})).toBe(false);
    });

    it('arma el outcome sin el texto libre de la descripción ni datos del vecino', () => {
      expect(rule.apply({ data: RECLAMO })).toEqual({
        type: 'CrearIntervencionPorReclamo',
        payload: {
          reclamoId: 'rec-123',
          titulo: 'Auto estacionado en la bicisenda',
          prioridad: 'ALTA',
          latitud: -34.6037,
          longitud: -58.3816,
          direccion: 'Av. Corrientes 1234',
          barrio: 'San Nicolás',
          correlationId: '0d9f7f0e-5a52-4f5e-9a55-2f6f0c1f3a10',
        },
      });
    });

    it('los opcionales ausentes o de otro tipo van en null', () => {
      const { payload } = rule.apply({
        data: { reclamoId: 'rec-1', categoria: 'TRANSITO', objetoAfectado: 'CICLOVIA', latitud: '-34.6', longitud: null },
      });
      expect(payload).toEqual({
        reclamoId: 'rec-1', titulo: null, prioridad: null, latitud: null, longitud: null,
        direccion: null, barrio: null, correlationId: null,
      });
    });
  });

  describe('CerrarIntervencionPorReclamoRule', () => {
    const rule = new CerrarIntervencionPorReclamoRule();
    const applies = (estadoNuevo, reclamoId = 'rec-123') => rule.appliesTo({ data: { reclamoId, estadoNuevo } });

    it('aplica cuando el reclamo llega a un estado final', () => {
      expect(applies('RESUELTO')).toBe(true);
      expect(applies('RECHAZADO')).toBe(true);
      expect(applies('CERRADO')).toBe(true);
      expect(applies('resuelto')).toBe(true);
    });

    it('no aplica a los estados intermedios ni sin reclamoId', () => {
      for (const estado of ['RECIBIDO', 'EN_REVISION', 'ASIGNADO', 'EN_PROCESO', undefined]) {
        expect(applies(estado)).toBe(false);
      }
      expect(applies('RESUELTO', '')).toBe(false);
      expect(rule.appliesTo({})).toBe(false);
    });

    it('el outcome lleva el reclamo y el estado normalizado', () => {
      expect(rule.apply({ data: { reclamoId: 'rec-123', estadoNuevo: 'resuelto' } })).toEqual({
        type: 'CerrarIntervencionPorReclamo',
        payload: { reclamoId: 'rec-123', estado: 'RESUELTO' },
      });
    });
  });
});
