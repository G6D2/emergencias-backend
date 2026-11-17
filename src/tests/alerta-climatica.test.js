jest.mock('../security/secure-log', () => ({ secureLog: jest.fn() }));

const { secureLog } = require('../security/secure-log');
const {
  GRAVEDADES,
  TIPOS_POR_FENOMENO,
  TIPOS_FENOMENO_DESCONOCIDO,
  normalizarGravedad,
  normalizarFenomeno,
  esFenomenoConocido,
  gravedadMinima,
  tiposAfectados,
  ventanaAlertaClimatica,
  CRITICIDAD_A_GRAVEDAD,
  gravedadDesdeEvento,
} = require('../domain/alerta-climatica');
const http = require('http');
const avro = require('avsc');
const { createEventDecoder, registryFromEnv, MAGIC_BYTE } = require('../listeners/event-decoder');
const { normalizarEnvelope } = require('../listeners/alerta-climatica/envelope');
const alertaClimatica = require('../listeners/alerta-climatica');
const { RegistrarContextoClimaRule } = require('../listeners/alerta-climatica/alerta-climatica-confirmada/rules/01-registrar-contexto-clima.rule');
const { DarDeBajaContextoClimaRule } = require('../listeners/alerta-climatica/alerta-climatica-finalizada/rules/01-dar-de-baja-contexto-clima.rule');
const { createRegistrarContextoZonaHandler } = require('../listeners/cobertura-preventiva/handlers/contexto-zona.handler');
const { ContextoZonaRepository, mapContextoZona } = require('../repositories/contexto-zona.repository');
const { ContextoZonaController, toContextoActivo } = require('../controllers/contexto-zona.controller');

const HORA = 60 * 60 * 1000;
const ALERTA_ID = '0b0e5c1a-7f3e-4a8e-9a51-2d5f1c7e9b10';
const EVENT_ID = '6b1f7c2e-4d3a-4f5b-8a9c-1d2e3f4a5b6c';

function alerta(overrides = {}) {
  return {
    alertaId: ALERTA_ID,
    version: 1,
    fenomeno: 'TORMENTA_ELECTRICA',
    gravedad: 'ALTA',
    barrios: ['PALERMO'],
    fechaInicio: '2026-11-12T21:00:00Z',
    fechaFinEstimada: '2026-11-13T03:00:00Z',
    descripcion: 'Tormentas fuertes',
    ...overrides,
  };
}

function contexto(data, metadata = { eventId: EVENT_ID, occurredAt: '2026-11-12T20:00:00Z' }) {
  return { metadata, data };
}

beforeEach(() => {
  secureLog.mockClear();
});

describe('domain/alerta-climatica', () => {
  it('normalizarGravedad devuelve la gravedad canónica o null', () => {
    expect(normalizarGravedad(' alta ')).toBe('ALTA');
    expect(normalizarGravedad('EXTREMA')).toBe('EXTREMA');
    for (const valor of [null, undefined, '', 'ROJA', 3, {}]) {
      expect(normalizarGravedad(valor)).toBeNull();
    }
    expect(GRAVEDADES).toEqual(['LEVE', 'MEDIA', 'ALTA', 'EXTREMA']);
  });

  it('normalizarFenomeno y esFenomenoConocido', () => {
    expect(normalizarFenomeno(' lluvia_fuerte ')).toBe('LLUVIA_FUERTE');
    expect(normalizarFenomeno('  ')).toBeNull();
    expect(esFenomenoConocido('tornado')).toBe(true);
    expect(esFenomenoConocido('OLA_POLAR')).toBe(false);
    expect(esFenomenoConocido('toString')).toBe(false);
    expect(esFenomenoConocido(null)).toBe(false);
  });

  it('la tabla nunca eleva disturbios, otro, pánico ni preventiva', () => {
    const elevados = new Set(Object.values(TIPOS_POR_FENOMENO).flat());
    for (const tipo of ['DISTURBIO_EVENTO_MASIVO', 'OTRO', 'PANICO', 'PREVENTIVA']) {
      expect(elevados.has(tipo)).toBe(false);
    }
    expect(Object.isFrozen(TIPOS_POR_FENOMENO)).toBe(true);
    expect(Object.isFrozen(TIPOS_POR_FENOMENO.TORNADO)).toBe(true);
  });

  describe('tiposAfectados', () => {
    it('con ALTA o EXTREMA devuelve los tipos del fenómeno', () => {
      expect(tiposAfectados({ fenomeno: 'TORMENTA_ELECTRICA', gravedad: 'ALTA', env: {} }))
        .toEqual(['INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO']);
      expect(tiposAfectados({ fenomeno: 'frio_extremo', gravedad: 'extrema', env: {} })).toEqual(['MEDICA']);
    });

    it('con LEVE, MEDIA, nula o desconocida no eleva nada', () => {
      for (const gravedad of ['LEVE', 'MEDIA', null, undefined, 'ROJA']) {
        expect(tiposAfectados({ fenomeno: 'TORNADO', gravedad, env: {} })).toEqual([]);
      }
    });

    it('un fenómeno desconocido usa los tipos por defecto', () => {
      expect(tiposAfectados({ fenomeno: 'OLA_POLAR', gravedad: 'ALTA', env: {} })).toEqual(TIPOS_FENOMENO_DESCONOCIDO);
      expect(tiposAfectados({ fenomeno: null, gravedad: 'ALTA', env: {} })).toEqual(['INFRAESTRUCTURA']);
    });

    it('el umbral se configura con CONTEXTO_CLIMA_GRAVEDAD_MINIMA; uno inválido usa ALTA', () => {
      expect(tiposAfectados({ fenomeno: 'NIEBLA', gravedad: 'MEDIA', env: { CONTEXTO_CLIMA_GRAVEDAD_MINIMA: 'media' } }))
        .toEqual(['TRANSITO']);
      expect(tiposAfectados({ fenomeno: 'NIEBLA', gravedad: 'ALTA', env: { CONTEXTO_CLIMA_GRAVEDAD_MINIMA: 'EXTREMA' } }))
        .toEqual([]);
      expect(gravedadMinima({ CONTEXTO_CLIMA_GRAVEDAD_MINIMA: 'ROJA' })).toBe('ALTA');
      expect(gravedadMinima({})).toBe('ALTA');
    });

    it('devuelve una copia: modificarla no toca la tabla', () => {
      const tipos = tiposAfectados({ fenomeno: 'NIEBLA', gravedad: 'ALTA', env: {} });
      tipos.push('MEDICA');
      expect(TIPOS_POR_FENOMENO.NIEBLA).toEqual(['TRANSITO']);
    });
  });

  describe('ventanaAlertaClimatica', () => {
    const ahora = new Date('2026-11-12T22:00:00Z');

    it('con fin estimado: hasta el fin más el margen (3 h)', () => {
      const ventana = ventanaAlertaClimatica({
        fechaInicio: '2026-11-12T21:00:00Z', fechaFinEstimada: '2026-11-13T03:00:00Z', ahora, env: {},
      });
      expect(ventana.vigenteDesde.toISOString()).toBe('2026-11-12T21:00:00.000Z');
      expect(ventana.vigenteHasta.toISOString()).toBe('2026-11-13T06:00:00.000Z');
    });

    it('sin fin estimado, o con uno que no es posterior al inicio: el tope (24 h)', () => {
      const sinFin = ventanaAlertaClimatica({ fechaInicio: '2026-11-12T21:00:00Z', ahora, env: {} });
      expect(sinFin.vigenteHasta.getTime() - sinFin.vigenteDesde.getTime()).toBe(24 * HORA);

      const finAnterior = ventanaAlertaClimatica({
        fechaInicio: '2026-11-12T21:00:00Z', fechaFinEstimada: '2026-11-12T20:00:00Z', ahora, env: {},
      });
      expect(finAnterior.vigenteHasta.toISOString()).toBe('2026-11-13T21:00:00.000Z');
    });

    it('sin inicio válido arranca ahora; acepta epoch', () => {
      expect(ventanaAlertaClimatica({ fechaInicio: 'mañana', ahora, env: {} }).vigenteDesde).toBe(ahora);
      const epoch = ventanaAlertaClimatica({ fechaInicio: 1795197600, ahora, env: {} });
      expect(epoch.vigenteDesde.toISOString()).toBe('2026-11-20T18:00:00.000Z');
    });

    it('margen y tope se configuran por env; valores inválidos usan el default', () => {
      const env = { CONTEXTO_CLIMA_MARGEN_HORAS: '1', CONTEXTO_CLIMA_TOPE_HORAS: '2' };
      expect(ventanaAlertaClimatica({
        fechaInicio: '2026-11-12T21:00:00Z', fechaFinEstimada: '2026-11-12T23:00:00Z', ahora, env,
      }).vigenteHasta.toISOString()).toBe('2026-11-13T00:00:00.000Z');
      expect(ventanaAlertaClimatica({ fechaInicio: '2026-11-12T21:00:00Z', ahora, env }).vigenteHasta.toISOString())
        .toBe('2026-11-12T23:00:00.000Z');
      expect(ventanaAlertaClimatica({
        fechaInicio: '2026-11-12T21:00:00Z', ahora, env: { CONTEXTO_CLIMA_TOPE_HORAS: '-4' },
      }).vigenteHasta.toISOString()).toBe('2026-11-13T21:00:00.000Z');
    });
  });
});

describe('listeners/alerta-climatica/envelope', () => {
  it('toma la metadata del gateway si viene', () => {
    const metadata = { eventId: EVENT_ID, receivedAt: '2026-11-12T20:00:01Z' };
    expect(normalizarEnvelope({ metadata, data: { a: 1 } })).toEqual({ metadata, data: { a: 1 } });
  });

  it('arma la metadata con los campos de la raíz si no viene (ejemplo de Espacios)', () => {
    expect(normalizarEnvelope({
      eventId: EVENT_ID, eventType: 'x', occurredAt: 't', source: 's', otro: 'no', data: { a: 1 },
    })).toEqual({ metadata: { eventId: EVENT_ID, eventType: 'x', occurredAt: 't', source: 's' }, data: { a: 1 } });
  });

  it('tolera eventos vacíos o mal formados', () => {
    for (const event of [null, undefined, 'x', [], { data: 'x', metadata: [] }]) {
      expect(normalizarEnvelope(event)).toEqual({ metadata: {}, data: {} });
    }
  });
});

describe('listeners de alerta climática', () => {
  const kafka = { consumer: jest.fn() };
  let env;

  beforeEach(() => {
    env = process.env;
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it('toman el topic del env y no tienen default', () => {
    process.env.EDA_TOPIC_ALERTA_CLIMATICA_CONFIRMADA = 'clima.confirmada';
    process.env.EDA_TOPIC_ALERTA_CLIMATICA_FINALIZADA = 'clima.finalizada';
    expect(new alertaClimatica.AlertaClimaticaConfirmadaListener(kafka).topic).toBe('clima.confirmada');
    expect(new alertaClimatica.AlertaClimaticaFinalizadaListener(kafka).topic).toBe('clima.finalizada');

    delete process.env.EDA_TOPIC_ALERTA_CLIMATICA_CONFIRMADA;
    delete process.env.EDA_TOPIC_ALERTA_CLIMATICA_FINALIZADA;
    expect(new alertaClimatica.AlertaClimaticaConfirmadaListener(kafka).topic).toBeUndefined();
    expect(new alertaClimatica.AlertaClimaticaFinalizadaListener(kafka).topic).toBeUndefined();
  });

  it('el paquete exporta los dos listeners y normalizan el envelope plano', async () => {
    expect(alertaClimatica.listeners).toEqual([
      alertaClimatica.AlertaClimaticaConfirmadaListener,
      alertaClimatica.AlertaClimaticaFinalizadaListener,
    ]);
    const listener = new alertaClimatica.AlertaClimaticaConfirmadaListener(kafka);
    const outcomes = await listener.handle({ eventId: EVENT_ID, occurredAt: '2026-11-12T20:00:00Z', data: alerta() });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].payload.causationId).toBe(EVENT_ID);
    expect(listener.groupId).toBe('com.citypass.emergencias.AlertaClimaticaConfirmadaListener');
  });
});

describe('RegistrarContextoClimaRule', () => {
  const rule = new RegistrarContextoClimaRule();

  it('aplica con un alertaId UUID y al menos un barrio del catálogo', () => {
    expect(rule.appliesTo(contexto(alerta()))).toBe(true);
    expect(rule.appliesTo(contexto(alerta({ barrios: ['Narnia', 'villa crespo'] })))).toBe(true);
  });

  it('no aplica sin alertaId UUID', () => {
    for (const alertaId of [undefined, '', 'alerta-1', 7]) {
      expect(rule.appliesTo(contexto(alerta({ alertaId })))).toBe(false);
    }
  });

  it('sin ningún barrio del catálogo no aplica y lo deja en el log', () => {
    for (const barrios of [[], ['Narnia'], undefined, 'PALERMO']) {
      expect(rule.appliesTo(contexto(alerta({ barrios })))).toBe(false);
    }
    expect(secureLog).toHaveBeenCalledWith('warn', expect.stringMatching(/sin barrios reconocidos/), expect.any(Object));
  });

  it('arma el alta del contexto con barrios canónicos, tipos, ventana y trazabilidad', () => {
    const { type, payload } = rule.apply(contexto(alerta({
      barrios: ['palermo', 'Palermo', 'Villa Crespo'], version: 2, gravedad: 'alta',
    })));

    expect(type).toBe('RegistrarContextoZona');
    expect(payload).toEqual({
      tipo: 'ALERTA_CLIMATICA',
      origen: 'espacios',
      referenciaExterna: ALERTA_ID,
      barrios: ['PALERMO', 'VILLA CRESPO'],
      tiposEmergencia: ['INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO'],
      fenomeno: 'TORMENTA_ELECTRICA',
      gravedad: 'ALTA',
      versionOrigen: 2,
      vigenteDesde: new Date('2026-11-12T21:00:00Z'),
      vigenteHasta: new Date('2026-11-13T06:00:00Z'),
      ventanaPorDefecto: false,
      suspendido: false,
      descripcion: 'Tormentas fuertes',
      causationId: EVENT_ID,
      sourceUpdatedAt: new Date('2026-11-12T20:00:00Z'),
    });
    expect(secureLog).not.toHaveBeenCalled();
  });

  it('LEVE crea el contexto sin tipos (no eleva)', () => {
    expect(rule.apply(contexto(alerta({ gravedad: 'LEVE' }))).payload.tiposEmergencia).toEqual([]);
  });

  it('avisa en el log por barrios fuera del catálogo, fenómeno y gravedad desconocidos', () => {
    const { payload } = rule.apply(contexto(alerta({ barrios: ['PALERMO', 'Narnia'], fenomeno: 'OLA_POLAR', gravedad: 'ROJA' })));
    expect(payload.barrios).toEqual(['PALERMO']);
    expect(payload.fenomeno).toBe('OLA_POLAR');
    expect(payload.gravedad).toBeNull();
    expect(payload.tiposEmergencia).toEqual([]);
    const mensajes = secureLog.mock.calls.map(([, mensaje]) => mensaje);
    expect(mensajes).toEqual(expect.arrayContaining([
      expect.stringMatching(/fuera del catálogo/),
      expect.stringMatching(/fenómeno desconocido/),
      expect.stringMatching(/gravedad desconocida/),
    ]));
  });

  it('version inválida, descripción larga y metadata sin UUID ni fechas', () => {
    const antes = Date.now();
    const { payload } = rule.apply(contexto(
      alerta({ version: -1, descripcion: 'x'.repeat(300) }),
      { eventId: 'no-uuid' }
    ));
    expect(payload.versionOrigen).toBeNull();
    expect(payload.descripcion).toHaveLength(200);
    expect(payload.causationId).toBeNull();
    expect(payload.sourceUpdatedAt.getTime()).toBeGreaterThanOrEqual(antes);
    expect(rule.apply(contexto(alerta({ version: '2', descripcion: '' }))).payload).toMatchObject({
      versionOrigen: null, descripcion: null,
    });
  });
});

describe('DarDeBajaContextoClimaRule', () => {
  const rule = new DarDeBajaContextoClimaRule();

  it('aplica solo con un alertaId UUID', () => {
    expect(rule.appliesTo(contexto({ alertaId: ALERTA_ID }))).toBe(true);
    expect(rule.appliesTo(contexto({ alertaId: 'a-1' }))).toBe(false);
    expect(rule.appliesTo({ metadata: {} })).toBe(false);
  });

  it('da de baja el contexto de esa alerta', () => {
    expect(rule.apply(contexto({ alertaId: ALERTA_ID }))).toEqual({
      type: 'DarDeBajaContextoZona',
      payload: {
        tipo: 'ALERTA_CLIMATICA',
        origen: 'espacios',
        referenciaExterna: ALERTA_ID,
        causationId: EVENT_ID,
        sourceUpdatedAt: new Date('2026-11-12T20:00:00Z'),
      },
    });
  });
});

describe('RegistrarContextoZona con zona por barrios', () => {
  const client = {};
  const base = {
    tipo: 'ALERTA_CLIMATICA',
    origen: 'espacios',
    referenciaExterna: ALERTA_ID,
    vigenteDesde: new Date(),
    vigenteHasta: new Date(Date.now() + HORA),
  };

  it('acepta barrios sin punto ni radio', async () => {
    const contextoZonaRepository = { upsert: jest.fn().mockResolvedValue({ id: 'ctx-1' }) };
    const handler = createRegistrarContextoZonaHandler({ contextoZonaRepository });
    const payload = { ...base, barrios: ['PALERMO'] };

    await expect(handler(client, payload)).resolves.toEqual({ applied: true, contextoId: 'ctx-1' });
    expect(contextoZonaRepository.upsert).toHaveBeenCalledWith(client, payload);
  });

  it('rechaza un payload sin ninguna zona, nombrando las dos opciones', async () => {
    const handler = createRegistrarContextoZonaHandler({ contextoZonaRepository: { upsert: jest.fn() } });
    for (const barrios of [undefined, [], ['  '], [null], 'PALERMO']) {
      await expect(handler(client, { ...base, barrios }))
        .rejects.toThrow(/latitud, longitud y radioMetros, o al menos un barrio/);
    }
  });
});

describe('ContextoZonaRepository (alerta climática)', () => {
  it('upsert guarda barrios, tipos, fenómeno, gravedad y versión, y no pisa una versión mayor', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new ContextoZonaRepository(pool);

    await repository.upsert(null, {
      tipo: 'ALERTA_CLIMATICA', origen: 'espacios', referenciaExterna: ALERTA_ID,
      barrios: ['PALERMO'], tiposEmergencia: ['TRANSITO'], fenomeno: 'NIEBLA', gravedad: 'ALTA', versionOrigen: 3,
    });

    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/barrios, tipos_emergencia, fenomeno, gravedad, version_origen/);
    expect(sql).toMatch(/\$14::text\[\], \$15::text\[\], \$16, \$17, \$18/);
    expect(sql).toMatch(/barrios = EXCLUDED\.barrios/);
    expect(sql).toMatch(/contexto_zona\.version_origen IS NULL OR EXCLUDED\.version_origen IS NULL\s+OR contexto_zona\.version_origen <= EXCLUDED\.version_origen/);
    expect(values.slice(13)).toEqual([['PALERMO'], ['TRANSITO'], 'NIEBLA', 'ALTA', 3]);
  });

  it('findActivos trae los no dados de baja, no suspendidos y sin vencer, filtrando por tipo', async () => {
    const fila = {
      id: 'ctx-1', tipo: 'ALERTA_CLIMATICA', barrios: ['PALERMO'], tipos_emergencia: [],
      fenomeno: 'NIEBLA', gravedad: 'LEVE', version_origen: 1,
    };
    const executor = { query: jest.fn().mockResolvedValue({ rows: [fila] }) };
    const repository = new ContextoZonaRepository({ query: jest.fn() });

    const activos = await repository.findActivos(executor, { tipo: 'ALERTA_CLIMATICA' });

    expect(activos).toEqual([mapContextoZona(fila)]);
    expect(activos[0]).toMatchObject({
      barrios: ['PALERMO'], tiposEmergencia: [], fenomeno: 'NIEBLA', gravedad: 'LEVE', versionOrigen: 1,
    });
    const [sql, values] = executor.query.mock.calls[0];
    expect(sql).toMatch(/dado_de_baja_en IS NULL/);
    expect(sql).toMatch(/suspendido_en IS NULL/);
    expect(sql).toMatch(/vigente_hasta > now\(\)/);
    expect(sql).not.toMatch(/vigente_desde <= now\(\)/);
    expect(values).toEqual(['ALERTA_CLIMATICA']);
  });

  it('findActivos sin tipo usa el pool y pasa null', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(new ContextoZonaRepository(pool).findActivos()).resolves.toEqual([]);
    expect(pool.query.mock.calls[0][1]).toEqual([null]);
  });

  it('mapContextoZona deja en null los campos nuevos de un evento comunitario', () => {
    expect(mapContextoZona({ id: 'ctx-1', tipo: 'EVENTO_ESPACIO_PUBLICO' })).toMatchObject({
      barrios: null, tiposEmergencia: null, fenomeno: null, gravedad: null, versionOrigen: null,
    });
  });
});

describe('ContextoZonaController', () => {
  const activo = {
    id: 'ctx-1', referenciaExterna: ALERTA_ID, tipo: 'ALERTA_CLIMATICA', fenomeno: 'TORNADO', gravedad: 'ALTA',
    tiposEmergencia: ['MEDICA'], barrios: ['PALERMO'], descripcion: null, latitud: null,
    vigenteDesde: new Date('2026-11-12T21:00:00Z'), vigenteHasta: new Date('2026-11-13T06:00:00Z'),
  };

  it('toContextoActivo: eleva según los tipos y no expone punto ni ids internos', () => {
    expect(toContextoActivo(activo)).toEqual({
      referenciaExterna: ALERTA_ID,
      tipo: 'ALERTA_CLIMATICA',
      fenomeno: 'TORNADO',
      gravedad: 'ALTA',
      eleva: true,
      tiposEmergencia: ['MEDICA'],
      barrios: ['PALERMO'],
      descripcion: null,
      vigenteDesde: activo.vigenteDesde,
      vigenteHasta: activo.vigenteHasta,
    });
    expect(toContextoActivo({ ...activo, tiposEmergencia: [] }).eleva).toBe(false);
    // Un evento comunitario (tipos null) eleva todos los tipos.
    expect(toContextoActivo({ ...activo, tiposEmergencia: null, barrios: null }).eleva).toBe(true);
  });

  it('listActivos normaliza el tipo, lo valida y envuelve en data', async () => {
    const repository = { findActivos: jest.fn().mockResolvedValue([activo]) };
    const controller = new ContextoZonaController(repository);

    const result = await controller.listActivos({ tipo: ' alerta_climatica ' });
    expect(repository.findActivos).toHaveBeenCalledWith(null, { tipo: 'ALERTA_CLIMATICA' });
    expect(result.data).toHaveLength(1);

    await controller.listActivos();
    expect(repository.findActivos).toHaveBeenLastCalledWith(null, { tipo: null });

    for (const tipo of ['FIESTA', '', ['ALERTA_CLIMATICA']]) {
      await expect(controller.listActivos({ tipo })).rejects.toMatchObject({ statusCode: 400 });
    }
  });
});

// ── Contrato real de Espacios (CriticidadClimaticaConfirmada) ───────────────
// Ejemplo de la guía "CityPass Eventos climáticos" (13/11/2026): ola de calor
// ALTA del 13/11 18:00 al 14/11 00:00 (hora de Buenos Aires).
const ALERTA_REAL_ID = 'f6029e4f-e0ef-46b8-9f1a-66e814f1c90e';
const VIGENCIA_DESDE = 1794603600000;
const VIGENCIA_HASTA = 1794625200000;
const PALERMO_PUNTO = { latitud: -34.5740, longitud: -58.4160 };
const RECOLETA_PUNTO = { latitud: -34.5869, longitud: -58.3930 };
const LA_PLATA_PUNTO = { latitud: -34.9214, longitud: -57.9545 };

function alertaReal(overrides = {}) {
  return {
    alertaId: ALERTA_REAL_ID,
    nivelCriticidad: 'ALTA',
    fenomeno: 'OLA_DE_CALOR',
    ubicaciones: [
      { latitud: -34.6037, longitud: -58.3816 },
      { latitud: -34.609099, longitud: -58.403062 },
    ],
    barrios: ['BALVANERA', 'SAN NICOLAS'],
    vigenciaDesde: VIGENCIA_DESDE,
    vigenciaHasta: VIGENCIA_HASTA,
    temperaturaMinC: 28.0,
    temperaturaMaxC: 38.0,
    actorSub: 'admin-ejemplo',
    ...overrides,
  };
}

describe('contrato real: criticidad y fenómenos de Espacios', () => {
  it('gravedadDesdeEvento traduce nivelCriticidad a la gravedad canónica', () => {
    expect(gravedadDesdeEvento({ nivelCriticidad: 'BAJA' })).toBe('LEVE');
    expect(gravedadDesdeEvento({ nivelCriticidad: 'MEDIA' })).toBe('MEDIA');
    expect(gravedadDesdeEvento({ nivelCriticidad: 'ALTA' })).toBe('ALTA');
    expect(gravedadDesdeEvento({ nivelCriticidad: ' critica ' })).toBe('EXTREMA');
    expect(CRITICIDAD_A_GRAVEDAD).toEqual({ BAJA: 'LEVE', MEDIA: 'MEDIA', ALTA: 'ALTA', CRITICA: 'EXTREMA' });
    expect(Object.isFrozen(CRITICIDAD_A_GRAVEDAD)).toBe(true);
  });

  it('gravedad (formato del ejemplo) gana sobre nivelCriticidad; un valor desconocido es null', () => {
    expect(gravedadDesdeEvento({ gravedad: 'LEVE', nivelCriticidad: 'CRITICA' })).toBe('LEVE');
    expect(gravedadDesdeEvento({ gravedad: 'ROJA', nivelCriticidad: 'ALTA' })).toBe('ALTA');
    expect(gravedadDesdeEvento({ nivelCriticidad: 'ROJA' })).toBeNull();
    expect(gravedadDesdeEvento({ nivelCriticidad: 'toString' })).toBeNull();
    expect(gravedadDesdeEvento({})).toBeNull();
    expect(gravedadDesdeEvento()).toBeNull();
  });

  it('los 5 fenómenos nuevos elevan sus tipos con ALTA y nada con BAJA o MEDIA', () => {
    const esperado = {
      LLUVIA_INTENSA: ['INFRAESTRUCTURA', 'TRANSITO'],
      TORMENTA_FUERTE: ['INFRAESTRUCTURA', 'TRANSITO'],
      OLA_DE_FRIO: ['MEDICA'],
      HURACAN: ['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO'],
      NIEVE: ['MEDICA', 'INFRAESTRUCTURA', 'TRANSITO'],
    };
    for (const [fenomeno, tipos] of Object.entries(esperado)) {
      expect(esFenomenoConocido(fenomeno)).toBe(true);
      expect(tiposAfectados({ fenomeno, gravedad: 'ALTA', env: {} })).toEqual(tipos);
      expect(tiposAfectados({ fenomeno, gravedad: gravedadDesdeEvento({ nivelCriticidad: 'BAJA' }), env: {} })).toEqual([]);
      expect(tiposAfectados({ fenomeno, gravedad: 'MEDIA', env: {} })).toEqual([]);
    }
  });

  it('los 9 fenómenos del catálogo real están en la tabla', () => {
    for (const fenomeno of [
      'TORMENTA_FUERTE', 'LLUVIA_INTENSA', 'VIENTO_FUERTE', 'OLA_DE_CALOR', 'OLA_DE_FRIO',
      'GRANIZO', 'TORMENTA_ELECTRICA', 'HURACAN', 'NIEVE',
    ]) {
      expect(esFenomenoConocido(fenomeno)).toBe(true);
    }
  });
});

describe('RegistrarContextoClimaRule con el contrato real', () => {
  const rule = new RegistrarContextoClimaRule();
  const metadataGateway = { eventId: EVENT_ID, receivedAt: '2026-11-13T20:59:00Z' };

  it('el payload de la guía aplica, con barrios canónicos, tipos de ola de calor y la ventana de vigencia', () => {
    const contextoReal = { metadata: metadataGateway, data: alertaReal() };
    expect(rule.appliesTo(contextoReal)).toBe(true);
    const { type, payload } = rule.apply(contextoReal);

    expect(type).toBe('RegistrarContextoZona');
    expect(payload).toMatchObject({
      tipo: 'ALERTA_CLIMATICA',
      referenciaExterna: ALERTA_REAL_ID,
      barrios: ['BALVANERA', 'SAN NICOLAS'],
      tiposEmergencia: ['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA'],
      fenomeno: 'OLA_DE_CALOR',
      gravedad: 'ALTA',
      versionOrigen: null,
      descripcion: null,
      causationId: EVENT_ID,
    });
    expect(payload.vigenteDesde.getTime()).toBe(VIGENCIA_DESDE);
    expect(payload.vigenteHasta.getTime()).toBe(VIGENCIA_HASTA + 3 * HORA);
    expect(payload.sourceUpdatedAt.toISOString()).toBe('2026-11-13T20:59:00.000Z');
    expect(secureLog).not.toHaveBeenCalled();
  });

  it('CRITICA eleva como EXTREMA', () => {
    const { payload } = rule.apply(contexto(alertaReal({ nivelCriticidad: 'CRITICA' })));
    expect(payload.gravedad).toBe('EXTREMA');
    expect(payload.tiposEmergencia).toEqual(['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA']);
  });

  it('con barrios vacío y ubicaciones en CABA, deriva los barrios por coordenadas', () => {
    const data = alertaReal({ barrios: [], ubicaciones: [PALERMO_PUNTO, RECOLETA_PUNTO, PALERMO_PUNTO, LA_PLATA_PUNTO] });
    expect(rule.appliesTo(contexto(data))).toBe(true);
    expect(rule.apply(contexto(data)).payload.barrios).toEqual(['PALERMO', 'RECOLETA']);

    // Las coordenadas de la guía dan los mismos barrios que manda Espacios.
    const guia = rule.apply(contexto(alertaReal({ barrios: [] }))).payload.barrios;
    expect([...guia].sort()).toEqual(['BALVANERA', 'SAN NICOLAS']);
  });

  it('también deriva por coordenadas si ningún barrio enviado está en el catálogo', () => {
    const { payload } = rule.apply(contexto(alertaReal({ barrios: ['NARNIA'], ubicaciones: [PALERMO_PUNTO] })));
    expect(payload.barrios).toEqual(['PALERMO']);
  });

  it('con barrios vacío y ubicaciones fuera de CABA (o inválidas), no aplica y deja el warn', () => {
    const data = alertaReal({
      barrios: [],
      ubicaciones: [LA_PLATA_PUNTO, { latitud: 'x', longitud: -58.4 }, null, { latitud: -34.6 }],
    });
    expect(rule.appliesTo(contexto(data))).toBe(false);
    expect(secureLog).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/sin barrios reconocidos/),
      expect.objectContaining({ ubicaciones: 4 })
    );
  });

  it('con más de 50 ubicaciones procesa solo las primeras 50 y lo deja en el log', () => {
    const ubicaciones = [
      ...Array.from({ length: 49 }, () => LA_PLATA_PUNTO),
      PALERMO_PUNTO, // la 50: se procesa
      ...Array.from({ length: 10 }, () => RECOLETA_PUNTO), // de la 51 en adelante: no
    ];
    const data = alertaReal({ barrios: [], ubicaciones });

    expect(rule.appliesTo(contexto(data))).toBe(true);
    expect(rule.apply(contexto(data)).payload.barrios).toEqual(['PALERMO']);
    expect(secureLog).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/más de 50 ubicaciones/),
      expect.objectContaining({ ubicaciones: 60 })
    );
  });

  it('una criticidad desconocida no eleva y el warn loguea gravedad y nivelCriticidad', () => {
    const { payload } = rule.apply(contexto(alertaReal({ nivelCriticidad: 'ROJA' })));
    expect(payload.gravedad).toBeNull();
    expect(payload.tiposEmergencia).toEqual([]);
    expect(secureLog).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/gravedad desconocida/),
      expect.objectContaining({ gravedad: null, nivelCriticidad: 'ROJA' })
    );
  });

  it('el formato del ejemplo anterior da el mismo resultado que antes', () => {
    const { payload } = rule.apply(contexto(alerta()));
    expect(payload).toMatchObject({
      barrios: ['PALERMO'],
      gravedad: 'ALTA',
      tiposEmergencia: ['INCENDIO', 'INFRAESTRUCTURA', 'TRANSITO'],
      versionOrigen: 1,
      descripcion: 'Tormentas fuertes',
    });
    expect(payload.vigenteDesde).toEqual(new Date('2026-11-12T21:00:00Z'));
    expect(payload.vigenteHasta).toEqual(new Date('2026-11-13T06:00:00Z'));
  });

  it('la finalización real (alertaId, finalizadaEn, actorSub) da de baja por alertaId', () => {
    const baja = new DarDeBajaContextoClimaRule();
    const contextoReal = {
      metadata: metadataGateway,
      data: { alertaId: ALERTA_REAL_ID, finalizadaEn: VIGENCIA_HASTA, actorSub: 'admin-ejemplo' },
    };
    expect(baja.appliesTo(contextoReal)).toBe(true);
    expect(baja.apply(contextoReal).payload).toMatchObject({
      tipo: 'ALERTA_CLIMATICA',
      referenciaExterna: ALERTA_REAL_ID,
      // finalizadaEn no se usa: es reloj de Espacios y el alta usa el del gateway.
      sourceUpdatedAt: new Date('2026-11-13T20:59:00Z'),
    });
  });
});

// Schema Avro RECONSTRUIDO a partir de la guía de Espacios (no es el que
// registraron en scripts/register-event-types.ts): envelope del gateway con
// metadata, enums de criticidad y fenómeno, barrios con default [], fechas
// long timestamp-millis y temperaturas opcionales. Si llega el schema real,
// reemplazarlo acá.
const CRITICIDAD_CLIMATICA_CONFIRMADA_SCHEMA = {
  type: 'record',
  name: 'CriticidadClimaticaConfirmadaEnvelope',
  namespace: 'com.citypass.espacios',
  fields: [
    {
      name: 'metadata',
      type: {
        type: 'record',
        name: 'Metadata',
        fields: [
          { name: 'eventId', type: 'string' },
          { name: 'eventType', type: 'string' },
          { name: 'source', type: 'string' },
          { name: 'receivedAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
        ],
      },
    },
    {
      name: 'data',
      type: {
        type: 'record',
        name: 'CriticidadClimaticaConfirmada',
        fields: [
          { name: 'alertaId', type: { type: 'string', logicalType: 'uuid' } },
          { name: 'nivelCriticidad', type: { type: 'enum', name: 'NivelCriticidad', symbols: ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'] } },
          {
            name: 'fenomeno',
            type: {
              type: 'enum',
              name: 'Fenomeno',
              symbols: ['TORMENTA_FUERTE', 'LLUVIA_INTENSA', 'VIENTO_FUERTE', 'OLA_DE_CALOR', 'OLA_DE_FRIO',
                'GRANIZO', 'TORMENTA_ELECTRICA', 'HURACAN', 'NIEVE'],
            },
          },
          {
            name: 'ubicaciones',
            type: {
              type: 'array',
              items: {
                type: 'record',
                name: 'Ubicacion',
                fields: [{ name: 'latitud', type: 'double' }, { name: 'longitud', type: 'double' }],
              },
            },
          },
          { name: 'barrios', type: { type: 'array', items: 'string' }, default: [] },
          { name: 'vigenciaDesde', type: { type: 'long', logicalType: 'timestamp-millis' } },
          { name: 'vigenciaHasta', type: { type: 'long', logicalType: 'timestamp-millis' } },
          { name: 'temperaturaMinC', type: ['null', 'double'], default: null },
          { name: 'temperaturaMaxC', type: ['null', 'double'], default: null },
          { name: 'actorSub', type: 'string' },
        ],
      },
    },
  ],
};

describe('decoder con el schema de CriticidadClimaticaConfirmada', () => {
  const SCHEMA_ID = 7311;
  let server;
  let registry;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === `/schemas/ids/${SCHEMA_ID}`) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.schemaregistry.v1+json' });
        res.end(JSON.stringify({ schema: JSON.stringify(CRITICIDAD_CLIMATICA_CONFIRMADA_SCHEMA) }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/vnd.schemaregistry.v1+json' });
        res.end(JSON.stringify({ error_code: 40403, message: 'Schema not found' }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    registry = registryFromEnv({ EDA_SCHEMA_REGISTRY_URL: `http://127.0.0.1:${server.address().port}` });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('llega con criticidad y fenómeno como string y las fechas como número de ms, y la regla lo entiende', async () => {
    const event = {
      metadata: {
        eventId: EVENT_ID,
        eventType: 'com.citypass.espacios.CriticidadClimaticaConfirmada',
        source: 'grupo7',
        receivedAt: 1794603540000,
      },
      data: alertaReal(),
    };
    const header = Buffer.alloc(5);
    header.writeUInt8(MAGIC_BYTE, 0);
    header.writeInt32BE(SCHEMA_ID, 1);
    const value = Buffer.concat([header, avro.Type.forSchema(CRITICIDAD_CLIMATICA_CONFIRMADA_SCHEMA).toBuffer(event)]);

    const decoded = await createEventDecoder({ registry }).decode(value);

    expect(decoded.data.nivelCriticidad).toBe('ALTA');
    expect(decoded.data.fenomeno).toBe('OLA_DE_CALOR');
    expect(decoded.data.vigenciaDesde).toBe(VIGENCIA_DESDE);
    expect(decoded.data.vigenciaHasta).toBe(VIGENCIA_HASTA);
    expect(decoded.metadata.receivedAt).toBe(1794603540000);
    expect(decoded.data.barrios).toEqual(['BALVANERA', 'SAN NICOLAS']);

    const listener = new alertaClimatica.AlertaClimaticaConfirmadaListener({ consumer: jest.fn() });
    const [outcome] = await listener.handle(decoded);
    expect(outcome.payload).toMatchObject({ gravedad: 'ALTA', barrios: ['BALVANERA', 'SAN NICOLAS'] });
    expect(outcome.payload.vigenteDesde.getTime()).toBe(VIGENCIA_DESDE);
    expect(outcome.payload.sourceUpdatedAt.getTime()).toBe(1794603540000);
  });
});
