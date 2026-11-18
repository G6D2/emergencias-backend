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
  it('zona por barrio: una entrada por alerta que junta los barrios de sus contextos, sin radio', () => {
    const [alerta, ...resto] = resumirAlertasActivas([
      contexto({ radioMetros: 3837 }),
      contexto({ referenciaExterna: `${ALERTA_ID}#1`, barrios: ['RECOLETA'], radioMetros: 4084 }),
      contexto({ referenciaExterna: `${ALERTA_ID}#2`, barrios: ['PALERMO'], radioMetros: 3837 }),
    ]);

    expect(resto).toEqual([]);
    expect(alerta).toEqual({
      alertaId: ALERTA_ID,
      nivel: 'ALTA',
      fenomeno: 'TORMENTA_FUERTE',
      fenomenoEtiqueta: 'Tormenta fuerte',
      barrios: ['PALERMO', 'RECOLETA'],
      zona: 'BARRIOS',
      vigenteDesde: new Date('2026-11-17T18:00:00Z'),
      vigenteHasta: new Date('2026-11-17T23:00:00Z'),
      enCurso: true,
      puntos: 3,
      radioMetros: null,
      descripcion: 'Alerta climática ALTA: tormenta fuerte',
    });
  });

  it('zona por punto: sin barrios, informa el radio del nivel y cuenta los puntos', () => {
    const [alerta] = resumirAlertasActivas([
      contexto({ barrios: null }),
      contexto({ referenciaExterna: `${ALERTA_ID}#1`, barrios: null }),
    ]);

    expect(alerta).toMatchObject({ barrios: [], zona: 'PUNTOS', puntos: 2, radioMetros: 500 });
  });

  it('los datos salen del primer contexto; está en curso si alguno lo está', () => {
    const [alerta] = resumirAlertasActivas([
      contexto({ enCurso: false, barrios: null }),
      contexto({ referenciaExterna: `${ALERTA_ID}#1`, enCurso: true, barrios: null }),
      contexto({ referenciaExterna: `${ALERTA_ID}#2`, enCurso: false, radioMetros: 1000, barrios: null }),
    ]);

    expect(alerta).toMatchObject({ enCurso: true, puntos: 3, radioMetros: 500, zona: 'PUNTOS' });
  });

  it('sin datos de la alerta (contexto anterior a V33): nulls, barrios vacíos y zona por punto', () => {
    const [alerta] = resumirAlertasActivas([{
      tipo: 'ALERTA_CLIMATICA', referenciaExterna: `${ALERTA_ID}#0`,
    }]);
    expect(alerta).toEqual({
      alertaId: ALERTA_ID,
      nivel: null,
      fenomeno: null,
      fenomenoEtiqueta: null,
      barrios: [],
      zona: 'PUNTOS',
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

  it('la regla manda nivel, fenómeno normalizado y una zona por barrio, sin repetir', () => {
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
    expect(payload).toMatchObject({ nivel: 'CRITICA', fenomeno: 'GRANIZO' });
    expect(payload.ubicaciones.map((u) => [u.indice, u.barrio])).toEqual([[0, 'PALERMO'], [2, 'BELGRANO']]);
  });

  it('sin fenómeno ni barrios, la regla manda null y zonas por punto', () => {
    const { payload } = new RegistrarContextosClimaticosRule().apply({
      data: { alertaId: ALERTA_ID, nivelCriticidad: 'ALTA', ubicaciones: [{ latitud: -34.6, longitud: -58.4 }] },
    });
    expect(payload).toMatchObject({ nivel: 'ALTA', fenomeno: null });
    expect(payload.ubicaciones).toEqual([{ indice: 0, latitud: -34.6, longitud: -58.4, radioMetros: 500, barrio: null }]);
  });

  function repo() {
    return {
      bloquearGrupo: jest.fn().mockResolvedValue(),
      grupoDadoDeBaja: jest.fn().mockResolvedValue(false),
      upsert: jest.fn().mockResolvedValue({ id: 'ctx' }),
    };
  }

  function emergencyRepo() {
    return { linkOpenEmergenciesToZoneContext: jest.fn().mockResolvedValue([]) };
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

  it('el handler guarda nivel y fenómeno en cada contexto, y en la zona por barrio su barrio y su radio', async () => {
    const contextoZonaRepository = repo();
    await createRegistrarContextosClimaticosHandler({ contextoZonaRepository, emergencyRepository: emergencyRepo() })(
      { query: jest.fn() },
      {
        ...base,
        nivel: 'CRITICA',
        fenomeno: 'GRANIZO',
        ubicaciones: [
          { indice: 0, latitud: -34.56, longitud: -58.41, radioMetros: 3837, barrio: 'PALERMO' },
          { indice: 2, latitud: -34.57, longitud: -58.38, radioMetros: 4084, barrio: 'RECOLETA' },
        ],
      }
    );
    expect(contextoZonaRepository.upsert).toHaveBeenCalledTimes(2);
    const [[, palermo], [, recoleta]] = contextoZonaRepository.upsert.mock.calls;
    expect(palermo).toMatchObject({
      referenciaExterna: `${ALERTA_ID}#0`, nivelCriticidad: 'CRITICA', fenomeno: 'GRANIZO', barrios: ['PALERMO'], radioMetros: 3837,
    });
    expect(recoleta).toMatchObject({ referenciaExterna: `${ALERTA_ID}#2`, barrios: ['RECOLETA'], radioMetros: 4084 });
  });

  it('el handler guarda barrios null en la zona por punto, con el radio del payload', async () => {
    const contextoZonaRepository = repo();
    await createRegistrarContextosClimaticosHandler({ contextoZonaRepository, emergencyRepository: emergencyRepo() })({ query: jest.fn() }, base);
    await createRegistrarContextosClimaticosHandler({ contextoZonaRepository, emergencyRepository: emergencyRepo() })(
      { query: jest.fn() },
      { ...base, ubicaciones: base.ubicaciones.map((u) => ({ ...u, barrio: null, radioMetros: null })) }
    );
    for (const [, punto] of contextoZonaRepository.upsert.mock.calls) {
      expect(punto).toMatchObject({ nivelCriticidad: null, fenomeno: null, barrios: null, radioMetros: 1000 });
    }
  });

  it('el handler rechaza una zona sin radio propio si el payload tampoco trae uno', async () => {
    const handler = createRegistrarContextosClimaticosHandler({ contextoZonaRepository: repo(), emergencyRepository: emergencyRepo() });
    await expect(handler({ query: jest.fn() }, { ...base, radioMetros: null })).rejects.toThrow('radioMetros');
  });
});
