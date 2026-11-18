const fs = require('fs');
const {
  listBarrios,
  matchBarrioFromText,
  resolveBarrioFromPoint,
  resolveBarrio,
  zonaDelBarrio,
  NEAREST_BARRIO_MAX_METERS,
  _resetCatalogCache,
} = require('../domain/barrio');
const { haversineDistanceMeters } = require('../domain/rule-based-grouper');

describe('domain/barrio — catálogo oficial CABA', () => {
  it('expone los 48 barrios oficiales', () => {
    const names = listBarrios();
    expect(names).toHaveLength(48);
    expect(names).toEqual(expect.arrayContaining(['PALERMO', 'ALMAGRO', 'SAN TELMO', 'NUÑEZ']));
  });

  it('matchea texto libre solo si está en el catálogo (case/acentos)', () => {
    expect(matchBarrioFromText('almagro')).toBe('ALMAGRO');
    expect(matchBarrioFromText('  Nuñez  ')).toBe('NUÑEZ');
    expect(matchBarrioFromText('Villa Gral. Mitre')).toBe('VILLA GRAL. MITRE');
    expect(matchBarrioFromText('Centro')).toBeNull();
    expect(matchBarrioFromText('')).toBeNull();
    expect(matchBarrioFromText(null)).toBeNull();
  });

  it('resuelve punto-en-polígono para puntos conocidos de CABA', () => {
    expect(resolveBarrioFromPoint(-34.6037, -58.3816)).toBe('SAN NICOLAS');
    expect(resolveBarrioFromPoint(-34.5735, -58.4233)).toBe('PALERMO');
    expect(resolveBarrioFromPoint(-34.6211, -58.3736)).toBe('SAN TELMO');
    expect(resolveBarrioFromPoint(-34.9, -58.5)).toBeNull();
  });

  it('en huecos/bordes del GeoJSON simplificado cae al barrio más cercano (~100 m)', () => {
    // Punto de borde Palermo/Recoleta reportado en review: sin fallback daba null.
    const borde = resolveBarrioFromPoint(-34.5722, -58.3950);
    expect(borde).toMatch(/PALERMO|RECOLETA/);
  });

  it('en solapamientos elige un único barrio (vértice más cercano entre hits)', () => {
    // Punto Almagro/Caballito reportado en review: PIP puro devolvía ambos.
    const barrio = resolveBarrioFromPoint(-34.6150, -58.4298);
    expect(['ALMAGRO', 'CABALLITO']).toContain(barrio);
  });

  it('prioriza coordenadas sobre texto; sin coords usa el catálogo', () => {
    expect(resolveBarrio({
      latitude: -34.5735,
      longitude: -58.4233,
      barrioText: 'ALMAGRO',
    })).toBe('PALERMO');

    expect(resolveBarrio({
      latitude: null,
      longitude: null,
      barrioText: 'Caballito',
    })).toBe('CABALLITO');

    expect(resolveBarrio({
      latitude: null,
      longitude: null,
      barrioText: 'Centro',
    })).toBeNull();

    expect(resolveBarrio({})).toBeNull();
  });
});

describe('domain/barrio — zona circular de cada barrio', () => {
  const geojson = JSON.parse(fs.readFileSync(require.resolve('../domain/data/barrios-caba.geojson'), 'utf8'));
  const verticesDe = (nombre) => {
    const { geometry } = geojson.features.find((f) => f.properties.barrio === nombre);
    const anillos = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
    return anillos.flat();
  };

  it('los 48 barrios tienen centro y radio', () => {
    for (const nombre of listBarrios()) {
      const zona = zonaDelBarrio(nombre);
      expect(zona).toMatchObject({ barrio: nombre });
      expect(Number.isFinite(zona.latitud) && Number.isFinite(zona.longitud)).toBe(true);
      expect(Number.isInteger(zona.radioMetros)).toBe(true);
    }
  });

  it('el círculo cubre todos los vértices del barrio, con el margen de cercanía', () => {
    for (const nombre of listBarrios()) {
      const { latitud, longitud, radioMetros } = zonaDelBarrio(nombre);
      const masLejano = Math.max(...verticesDe(nombre).map(([lng, lat]) => haversineDistanceMeters(
        { latitude: latitud, longitude: longitud }, { latitude: lat, longitude: lng }
      )));
      expect(radioMetros - NEAREST_BARRIO_MAX_METERS).toBeGreaterThanOrEqual(masLejano);
      expect(radioMetros - NEAREST_BARRIO_MAX_METERS).toBeLessThan(masLejano + 1);
    }
  });

  it('el centro es el promedio de los vértices, sin contar dos veces el de cierre', () => {
    const vertices = verticesDe('COGHLAN').slice(0, -1);
    const zona = zonaDelBarrio('COGHLAN');
    expect(zona.longitud).toBeCloseTo(vertices.reduce((s, [lng]) => s + lng, 0) / vertices.length, 10);
    expect(zona.latitud).toBeCloseTo(vertices.reduce((s, [, lat]) => s + lat, 0) / vertices.length, 10);
  });

  it('el más chico es COGHLAN y los más grandes rondan los 4 km', () => {
    const radios = listBarrios().map((nombre) => zonaDelBarrio(nombre)).sort((a, b) => a.radioMetros - b.radioMetros);
    expect(radios[0].barrio).toBe('COGHLAN');
    expect(radios[0].radioMetros).toBeGreaterThan(800);
    expect(radios[0].radioMetros).toBeLessThan(1000);
    expect(radios.slice(-3).map((z) => z.barrio).sort()).toEqual(['BELGRANO', 'PALERMO', 'RECOLETA']);
    for (const zona of radios.slice(-3)) {
      expect(zona.radioMetros).toBeGreaterThan(3700);
      expect(zona.radioMetros).toBeLessThan(4200);
    }
  });

  it('acepta el nombre sin tildes ni mayúsculas; fuera del catálogo es null', () => {
    expect(zonaDelBarrio('nunez')).toEqual(zonaDelBarrio('NUÑEZ'));
    expect(zonaDelBarrio('palermo').barrio).toBe('PALERMO');
    expect(zonaDelBarrio('Narnia')).toBeNull();
    expect(zonaDelBarrio('')).toBeNull();
    expect(zonaDelBarrio(null)).toBeNull();
  });

  it('se calcula una vez: devuelve el mismo objeto congelado', () => {
    expect(zonaDelBarrio('PALERMO')).toBe(zonaDelBarrio('Palermo'));
    expect(Object.isFrozen(zonaDelBarrio('PALERMO'))).toBe(true);
  });
});

describe('domain/barrio — el GeoJSON no carga', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    _resetCatalogCache();
  });

  it('queda sin catálogo (barrio = null) y lo deja en el log una sola vez', () => {
    _resetCatalogCache();
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(listBarrios()).toEqual([]);
    expect(resolveBarrio({ latitude: -34.6037, longitude: -58.3816 })).toBeNull();
    expect(matchBarrioFromText('palermo')).toBeNull();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/No se pudo cargar el catálogo de barrios/);
    expect(errorSpy.mock.calls[0][0]).toMatch(/ENOENT/);
  });

  it('con el archivo de vuelta, el catálogo se carga normalmente', () => {
    _resetCatalogCache();
    expect(listBarrios()).toHaveLength(48);
  });
});
