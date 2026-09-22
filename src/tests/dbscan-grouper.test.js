const { groupNearbyEmergenciesDbscan } = require('../domain/dbscan-grouper');
const { haversineDistanceMeters } = require('../domain/rule-based-grouper');

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

describe('dbscan-grouper', () => {
  describe('groupNearbyEmergenciesDbscan', () => {
    it('agrupa dos emergencias de userId distintos a 50m con minUniqueCitizens=2', () => {
      const candidates = [
        candidate({ emergencyId: 'e1', userId: 'user-A' }),
        candidate({ emergencyId: 'e2', userId: 'user-B', ...NEARBY_POINT }),
      ];

      const groups = groupNearbyEmergenciesDbscan(candidates, { radiusMeters: 100, minUniqueCitizens: 2 });

      expect(groups).toHaveLength(1);
      expect(groups[0].slice().sort()).toEqual(['e1', 'e2']);
    });

    it('DBSCAN agrupa dos emergencias del MISMO userId a 50m por densidad, pero el filtro posterior las descarta (invariante anti-spam)', () => {
      const candidates = [
        candidate({ emergencyId: 'e1', userId: 'user-A' }),
        candidate({ emergencyId: 'e2', userId: 'user-A', ...NEARBY_POINT }),
      ];

      const groups = groupNearbyEmergenciesDbscan(candidates, { radiusMeters: 100, minUniqueCitizens: 2 });

      expect(groups).toEqual([]);
    });

    it('agrupa 3 candidatos en cadena (A-B=250m, B-C=250m, A-C=500m) por alcanzabilidad transitiva de densidad, mismo comportamiento que RuleBasedGrouper', () => {
      // Mismos valores que rule-based-grouper.test.js: A-B=100m, B-C=100m, A-C=500m
      // es geométricamente imposible (desigualdad triangular), por eso 250m/250m/500m
      // colineales sobre el mismo meridiano.
      const METERS_PER_DEGREE_LATITUDE = 111194.86; // ver haversineDistanceMeters: R * (pi/180)
      const offsetForMeters = (meters) => meters / METERS_PER_DEGREE_LATITUDE;

      const pointA = { latitude: -34.6037, longitude: -58.3816 };
      const pointB = { latitude: -34.6037 + offsetForMeters(250), longitude: -58.3816 };
      const pointC = { latitude: -34.6037 + offsetForMeters(500), longitude: -58.3816 };

      // Confirma las distancias reales antes de agrupar (no asumidas).
      expect(haversineDistanceMeters(pointA, pointB)).toBeCloseTo(250, 0);
      expect(haversineDistanceMeters(pointB, pointC)).toBeCloseTo(250, 0);
      const distanceAC = haversineDistanceMeters(pointA, pointC);
      expect(distanceAC).toBeCloseTo(500, 0);
      expect(distanceAC).toBeGreaterThan(300); // fuera de radiusMeters

      const candidates = [
        candidate({ emergencyId: 'A', userId: 'user-A', ...pointA }),
        candidate({ emergencyId: 'B', userId: 'user-B', ...pointB }),
        candidate({ emergencyId: 'C', userId: 'user-C', ...pointC }),
      ];

      const groups = groupNearbyEmergenciesDbscan(candidates, { radiusMeters: 300, minUniqueCitizens: 3 });

      // B es core point (A, B y C caen los tres dentro de 300m de B), así que
      // DBSCAN arrastra a A y C como border points del mismo cluster, pese a
      // que A-C están a 500m (> radiusMeters) entre sí -- misma semántica de
      // cadena que RuleBasedGrouper.
      expect(groups).toHaveLength(1);
      expect(groups[0].slice().sort()).toEqual(['A', 'B', 'C']);
    });

    it('no agrupa candidatos lejos entre sí', () => {
      const candidates = [
        candidate({ emergencyId: 'e1', userId: 'user-A' }),
        candidate({ emergencyId: 'e2', userId: 'user-B', latitude: -34.7, longitude: -58.5 }),
      ];

      const groups = groupNearbyEmergenciesDbscan(candidates, { radiusMeters: 300, minUniqueCitizens: 2 });

      expect(groups).toEqual([]);
    });

    it('candidates vacío devuelve [] sin llamar a la librería', () => {
      const groups = groupNearbyEmergenciesDbscan([], { radiusMeters: 300, minUniqueCitizens: 2 });

      expect(groups).toEqual([]);
    });
  });
});
