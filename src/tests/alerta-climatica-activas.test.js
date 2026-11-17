// Alertas climáticas activas para el banner del tablero (GET
// /api/contextos-zona/activos): los datos para mostrar que guarda cada
// contexto (nivel, fenómeno, barrios) y el resumen de una entrada por alerta.

jest.mock('../security/secure-log', () => ({ secureLog: jest.fn() }));

const {
  FENOMENOS,
  alertaIdDeReferencia,
  barriosParaMostrar,
  etiquetaFenomeno,
  fenomenoNormalizado,
  resumirAlertasActivas,
} = require('../domain/alerta-climatica');
const { RegistrarContextosClimaticosRule } = require('../listeners/alerta-climatica/criticidad-climatica-confirmada/rules/02-registrar-contextos-climaticos.rule');
const { createRegistrarContextosClimaticosHandler } = require('../listeners/alerta-climatica/handlers/contextos-climaticos.handler');

const ALERTA_ID = 'a7f0e2c4-1b3d-4e5f-8a9b-0c1d2e3f4a5b';

function contexto(overrides = {}) {
  return {
    tipo: 'ALERTA_CLIMATICA',
    referenciaExterna: `${ALERTA_ID}#0`,
    nivelCriticidad: 'ALTA',
    fenomeno: 'TORMENTA_FUERTE',
    barrios: ['PALERMO'],
    vigenteDesde: new Date('2026-11-17T18:00:00Z'),
    vigenteHasta: new Date('2026-11-17T23:00:00Z'),
    enCurso: true,
    radioMetros: 500,
    descripcion: 'Alerta climática ALTA: tormenta fuerte',
    ...overrides,
  };
}

describe('datos para mostrar una alerta climática', () => {
  it('el catálogo tiene los 9 fenómenos de Espacios', () => {
    expect(Object.keys(FENOMENOS)).toEqual([
      'TORMENTA_FUERTE', 'LLUVIA_INTENSA', 'VIENTO_FUERTE', 'OLA_DE_CALOR', 'OLA_DE_FRIO',
      'GRANIZO', 'TORMENTA_ELECTRICA', 'HURACAN', 'NIEVE',
    ]);
  });

  it('fenomenoNormalizado: mayúsculas, sin espacios alrededor y con tope; null sin texto', () => {
    expect(fenomenoNormalizado(' granizo ')).toBe('GRANIZO');
    expect(fenomenoNormalizado('X'.repeat(100))).toHaveLength(60);
    expect(fenomenoNormalizado('   ')).toBeNull();
    expect(fenomenoNormalizado(42)).toBeNull();
    expect(fenomenoNormalizado(undefined)).toBeNull();
  });

  it('etiquetaFenomeno: la del catálogo, o el código legible si es nuevo', () => {
    expect(etiquetaFenomeno('TORMENTA_ELECTRICA')).toBe('Tormenta eléctrica');
    expect(etiquetaFenomeno('ola_de_frio')).toBe('Ola de frío');
    expect(etiquetaFenomeno('OLA_POLAR')).toBe('Ola polar');
    expect(etiquetaFenomeno('___')).toBeNull();
    expect(etiquetaFenomeno(null)).toBeNull();
  });

  it('etiquetaFenomeno no confunde propiedades heredadas con fenómenos', () => {
    expect(etiquetaFenomeno('constructor')).toBe('Constructor');
    expect(etiquetaFenomeno('__proto__')).toBe('Proto');
  });

  it('barriosParaMostrar: sin vacíos ni repetidos, con tope de cantidad y largo', () => {
    expect(barriosParaMostrar({ barrios: [' PALERMO ', 'PALERMO', '', 3, 'RECOLETA'] })).toEqual(['PALERMO', 'RECOLETA']);
    expect(barriosParaMostrar({ barrios: ['B'.repeat(200)] })[0]).toHaveLength(80);
    expect(barriosParaMostrar({ barrios: Array.from({ length: 60 }, (_, i) => `BARRIO ${i}`) })).toHaveLength(48);
    expect(barriosParaMostrar({})).toEqual([]);
    expect(barriosParaMostrar()).toEqual([]);
  });

  it('alertaIdDeReferencia: corta el índice del punto; null para la marca de baja u otra cosa', () => {
    expect(alertaIdDeReferencia(`${ALERTA_ID}#0`)).toBe(ALERTA_ID);
    expect(alertaIdDeReferencia('alerta#7#12')).toBe('alerta#7');
    expect(alertaIdDeReferencia(ALERTA_ID)).toBeNull();
    expect(alertaIdDeReferencia('#3')).toBeNull();
    expect(alertaIdDeReferencia('alerta#')).toBeNull();
    expect(alertaIdDeReferencia('alerta#x')).toBeNull();
    expect(alertaIdDeReferencia(null)).toBeNull();
  });
});

describe('resumirAlertasActivas', () => {
  it('una entrada por alerta: cuenta los puntos y conserva nivel, fenómeno, barrios, ventana y radio', () => {
    const [alerta, ...resto] = resumirAlertasActivas([
      contexto(),
      contexto({ referenciaExterna: `${ALERTA_ID}#1` }),
    ]);

    expect(resto).toEqual([]);
    expect(alerta).toEqual({
      alertaId: ALERTA_ID,
      nivel: 'ALTA',
      fenomeno: 'TORMENTA_FUERTE',
      fenomenoEtiqueta: 'Tormenta fuerte',
      barrios: ['PALERMO'],
      vigenteDesde: new Date('2026-11-17T18:00:00Z'),
      vigenteHasta: new Date('2026-11-17T23:00:00Z'),
      enCurso: true,
      puntos: 2,
      radioMetros: 500,
      descripcion: 'Alerta climática ALTA: tormenta fuerte',
    });
  });

  it('los datos salen del primer punto; está en curso si algún punto lo está', () => {
    const [alerta] = resumirAlertasActivas([
      contexto({ enCurso: false }),
      contexto({ referenciaExterna: `${ALERTA_ID}#1`, enCurso: true }),
      contexto({ referenciaExterna: `${ALERTA_ID}#2`, enCurso: false, radioMetros: 1000 }),
    ]);

    expect(alerta).toMatchObject({ enCurso: true, puntos: 3, radioMetros: 500 });
  });

  it('sin datos de la alerta (contexto anterior a V33): nulls y barrios vacíos', () => {
    const [alerta] = resumirAlertasActivas([{
      tipo: 'ALERTA_CLIMATICA', referenciaExterna: `${ALERTA_ID}#0`,
    }]);
    expect(alerta).toEqual({
      alertaId: ALERTA_ID,
      nivel: null,
      fenomeno: null,
      fenomenoEtiqueta: null,
      barrios: [],
      vigenteDesde: null,
      vigenteHasta: null,
      enCurso: false,
      puntos: 1,
      radioMetros: null,
      descripcion: null,
    });
  });

  it('ignora eventos de espacios públicos, marcas de baja y filas vacías', () => {
    expect(resumirAlertasActivas([
      contexto({ tipo: 'EVENTO_ESPACIO_PUBLICO', referenciaExterna: 'ev-1#0' }),
      contexto({ referenciaExterna: ALERTA_ID }),
      null,
    ])).toEqual([]);
    expect(resumirAlertasActivas()).toEqual([]);
  });

  it('ordena: primero CRITICA, después por inicio, después por alertaId', () => {
    const alertas = resumirAlertasActivas([
      contexto({ referenciaExterna: 'b#0', vigenteDesde: new Date('2026-11-17T18:00:00Z') }),
      contexto({ referenciaExterna: 'a#0', vigenteDesde: new Date('2026-11-17T18:00:00Z') }),
      contexto({ referenciaExterna: 'temprana#0', vigenteDesde: new Date('2026-11-17T10:00:00Z') }),
      contexto({ referenciaExterna: 'critica#0', nivelCriticidad: 'CRITICA', vigenteDesde: new Date('2026-11-17T20:00:00Z') }),
      contexto({ referenciaExterna: 'sin-nivel#0', nivelCriticidad: null, vigenteDesde: null }),
      contexto({ referenciaExterna: 'sin-nivel-2#0', nivelCriticidad: null, vigenteDesde: '2026-11-17T09:00:00Z' }),
      contexto({ referenciaExterna: 'fecha-rota#0', nivelCriticidad: null, vigenteDesde: 'no es fecha' }),
    ]);
    expect(alertas.map((a) => a.alertaId)).toEqual([
      'critica', 'temprana', 'a', 'b', 'fecha-rota', 'sin-nivel', 'sin-nivel-2',
    ]);
  });
});

describe('alta de contextos: guarda los datos para mostrar', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-20T12:00:00Z'));
  });

  afterEach(() => jest.restoreAllMocks());

  it('la regla manda nivel, fenómeno normalizado y barrios en el payload', () => {
    const { payload } = new RegistrarContextosClimaticosRule().apply({
      metadata: {},
      data: {
        alertaId: ALERTA_ID,
        nivelCriticidad: 'Crítica',
        fenomeno: 'granizo',
        ubicaciones: [{ latitud: -34.6, longitud: -58.4 }],
        barrios: ['PALERMO', 'PALERMO', ' BELGRANO '],
        vigenciaDesde: 1792594800000,
        vigenciaHasta: 1792616400000,
      },
    });
    expect(payload).toMatchObject({ nivel: 'CRITICA', fenomeno: 'GRANIZO', barrios: ['PALERMO', 'BELGRANO'] });
  });

  it('sin fenómeno ni barrios, la regla manda null y []', () => {
    const { payload } = new RegistrarContextosClimaticosRule().apply({
      data: { alertaId: ALERTA_ID, nivelCriticidad: 'ALTA', ubicaciones: [{ latitud: -34.6, longitud: -58.4 }] },
    });
    expect(payload).toMatchObject({ nivel: 'ALTA', fenomeno: null, barrios: [] });
  });

  function repo() {
    return {
      bloquearGrupo: jest.fn().mockResolvedValue(),
      grupoDadoDeBaja: jest.fn().mockResolvedValue(false),
      upsert: jest.fn().mockResolvedValue({ id: 'ctx' }),
    };
  }

  const base = {
    origen: 'espacios',
    alertaId: ALERTA_ID,
    ubicaciones: [{ indice: 0, latitud: -34.6, longitud: -58.4 }, { indice: 1, latitud: -34.61, longitud: -58.41 }],
    radioMetros: 1000,
    vigenteDesde: new Date('2026-11-17T18:00:00Z'),
    vigenteHasta: new Date('2026-11-17T23:00:00Z'),
    sourceUpdatedAt: new Date('2026-11-17T17:00:00Z'),
  };

  it('el handler guarda nivel, fenómeno y barrios en cada punto', async () => {
    const contextoZonaRepository = repo();
    await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })(
      { query: jest.fn() },
      { ...base, nivel: 'CRITICA', fenomeno: 'GRANIZO', barrios: ['PALERMO'] }
    );
    expect(contextoZonaRepository.upsert).toHaveBeenCalledTimes(2);
    for (const [, punto] of contextoZonaRepository.upsert.mock.calls) {
      expect(punto).toMatchObject({ nivelCriticidad: 'CRITICA', fenomeno: 'GRANIZO', barrios: ['PALERMO'] });
    }
  });

  it('el handler guarda null si no vienen (payload anterior o sin barrios)', async () => {
    const contextoZonaRepository = repo();
    await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })({ query: jest.fn() }, base);
    await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })({ query: jest.fn() }, { ...base, barrios: [] });
    await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })({ query: jest.fn() }, { ...base, barrios: 'PALERMO' });
    for (const [, punto] of contextoZonaRepository.upsert.mock.calls) {
      expect(punto).toMatchObject({ nivelCriticidad: null, fenomeno: null, barrios: null });
    }
  });
});
