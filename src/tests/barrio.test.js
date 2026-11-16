const fs = require('fs');
const {
  listBarrios,
  matchBarrioFromText,
  resolveBarrioFromPoint,
  resolveBarrio,
  _resetCatalogCache,
} = require('../domain/barrio');

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
