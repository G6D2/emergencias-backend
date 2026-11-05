const {
  listBarrios,
  matchBarrioFromText,
  resolveBarrioFromPoint,
  resolveBarrio,
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
