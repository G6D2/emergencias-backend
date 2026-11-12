jest.mock('../../../security/secure-log', () => ({ secureLog: jest.fn() }));

const path = require('path');
const { EventListener, createListeners } = require('../../../listeners');
const { ReclamoCreadoListener, ReclamoActualizadoListener } = require('../../../listeners/reclamo-intervencion');
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

  it('createListeners suma los dos listeners del paquete', () => {
    const constructors = createListeners(kafka).map((l) => l.constructor);
    expect(constructors).toEqual(expect.arrayContaining([ReclamoCreadoListener, ReclamoActualizadoListener]));
  });

  it('sin variables de entorno escuchan los tópicos vigentes de Reclamos', () => {
    delete process.env.EDA_TOPIC_RECLAMO_CREADO;
    delete process.env.EDA_TOPIC_RECLAMO_ACTUALIZADO;
    expect(new ReclamoCreadoListener(kafka).topic).toBe('com.citypass.reclamos.ReclamoCreado.v3');
    expect(new ReclamoActualizadoListener(kafka).topic).toBe('com.citypass.reclamos.ReclamoActualizado');
  });

  it('el tópico se puede cambiar por env (otra versión del tipo)', () => {
    process.env.EDA_TOPIC_RECLAMO_CREADO = 'com.citypass.reclamos.ReclamoCreado.v4';
    process.env.EDA_TOPIC_RECLAMO_ACTUALIZADO = 'otro.ReclamoActualizado';
    expect(new ReclamoCreadoListener(kafka).topic).toBe('com.citypass.reclamos.ReclamoCreado.v4');
    expect(new ReclamoActualizadoListener(kafka).topic).toBe('otro.ReclamoActualizado');
  });

  it('son EventListener con group.id propio y reglas en su carpeta', () => {
    const base = path.join(__dirname, '../../../listeners/reclamo-intervencion');
    const creado = new ReclamoCreadoListener(kafka);
    const actualizado = new ReclamoActualizadoListener(kafka);
    expect(creado).toBeInstanceOf(EventListener);
    expect(creado.groupId).toBe('com.citypass.emergencias.ReclamoCreadoListener');
    expect(actualizado.groupId).toBe('com.citypass.emergencias.ReclamoActualizadoListener');
    expect(creado.rulesDir).toBe(path.join(base, 'reclamo-creado', 'rules'));
    expect(actualizado.rulesDir).toBe(path.join(base, 'reclamo-actualizado', 'rules'));
    expect(creado.rules().map((r) => r.constructor)).toEqual([CrearIntervencionPorReclamoRule]);
    expect(actualizado.rules().map((r) => r.constructor)).toEqual([CerrarIntervencionPorReclamoRule]);
  });

  describe('CrearIntervencionPorReclamoRule', () => {
    const rule = new CrearIntervencionPorReclamoRule();
    const applies = (overrides) => rule.appliesTo({ data: { ...RECLAMO, ...overrides } });

    it('aplica a un reclamo de tránsito sobre una ciclovía', () => {
      expect(applies({})).toBe(true);
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
