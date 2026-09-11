const { groupNearbyEmergencies, haversineDistanceMeters } = require('../domain/rule-based-grouper');

// Obelisco, desplazado ~50m al norte (offset puro de latitud, sin longitud).
const BASE_POINT = { latitude: -34.6037, longitude: -58.3816 };
const NEARBY_POINT = { latitude: -34.6037 + 0.00045, longitude: -58.3816 };

function candidate(overrides = {}) {
  return {
    emergencyId: 'emergency-id',
    userId: 'user-id',
    latitude: BASE_POINT.latitude,
    longitude: BASE_POINT.longitude,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('rule-based-grouper', () => {
  describe('groupNearbyEmergencies', () => {
    it('no agrupa dos emergencias del mismo userId a 50m si falta un ciudadano distinto', () => {
      const candidates = [
        candidate({ emergencyId: 'e1', userId: 'user-A' }),
        candidate({ emergencyId: 'e2', userId: 'user-A', ...NEARBY_POINT }),
      ];

      const groups = groupNearbyEmergencies(candidates, { radiusMeters: 100, minUniqueCitizens: 2 });

      expect(groups).toEqual([]);
    });

    it('agrupa dos emergencias de userId distintos a 50m con minUniqueCitizens=2', () => {
      const candidates = [
        candidate({ emergencyId: 'e1', userId: 'user-A' }),
        candidate({ emergencyId: 'e2', userId: 'user-B', ...NEARBY_POINT }),
      ];

      const groups = groupNearbyEmergencies(candidates, { radiusMeters: 100, minUniqueCitizens: 2 });

      expect(groups).toHaveLength(1);
      expect(groups[0].slice().sort()).toEqual(['e1', 'e2']);
    });

    it('no agrupa dos emergencias a más de radiusMeters de distancia', () => {
      const candidates = [
        candidate({ emergencyId: 'e1', userId: 'user-A' }),
        candidate({ emergencyId: 'e2', userId: 'user-B', ...NEARBY_POINT }),
      ];

      // La distancia real es ~50m; con radiusMeters=10 quedan fuera del radio.
      // minUniqueCitizens=1 aísla el efecto de la distancia: si no fuera por
      // el radio, cada una ya calificaría como grupo válido por sí sola.
      const groups = groupNearbyEmergencies(candidates, { radiusMeters: 10, minUniqueCitizens: 1 });

      expect(groups.some((group) => group.includes('e1') && group.includes('e2'))).toBe(false);
    });
  });

  describe('haversineDistanceMeters', () => {
    it('da un resultado razonable para dos puntos conocidos (offset puro de latitud ~111.19m/0.001°)', () => {
      const pointA = { latitude: -34.6037, longitude: -58.3816 };
      const pointB = { latitude: -34.6047, longitude: -58.3816 };

      const distance = haversineDistanceMeters(pointA, pointB);

      // Offset de solo latitud: la fórmula colapsa a R * deltaLat (radianes),
      // sin dependencia de la longitud. 6371000 * 0.001° en radianes ≈ 111.19m.
      expect(distance).toBeGreaterThan(110);
      expect(distance).toBeLessThan(112);
    });

    it('da 0 para el mismo punto', () => {
      const point = { latitude: -34.6037, longitude: -58.3816 };

      expect(haversineDistanceMeters(point, point)).toBeCloseTo(0, 6);
    });
  });
});
