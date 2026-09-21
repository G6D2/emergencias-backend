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

    it('DOCUMENTA el comportamiento actual: A-B y B-C dentro del radio arrastran a A y C al mismo grupo aunque A-C exceda el radio (transitividad de union-find)', () => {
      // Nota: no se puede usar A-B=100m, B-C=100m, A-C=500m — es geométricamente
      // imposible (desigualdad triangular: A-C <= A-B + B-C <= 200m siempre).
      // Se usa 250m/250m/500m, los tres puntos colineales sobre el mismo
      // meridiano (offset puro de latitud), para que las distancias se sumen
      // exactas y el par extremo (A-C) quede por encima de radiusMeters=300.
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

      const groups = groupNearbyEmergencies(candidates, { radiusMeters: 300, minUniqueCitizens: 3 });

      // Comportamiento REAL de la implementación actual: un solo grupo con
      // A, B y C juntos, pese a que A y C están a 500m (> radiusMeters=300)
      // entre sí. Esto es lo que hace el código hoy — no un "debería".
      expect(groups).toHaveLength(1);
      expect(groups[0].slice().sort()).toEqual(['A', 'B', 'C']);
    });

    it('agrupa 3 candidatos mutuamente cercanos (todos los pares dentro del radio) en un solo grupo', () => {
      // Triángulo pequeño donde A-B, A-C y B-C están todos dentro del radio:
      // al procesar el par B-C, find(B) y find(C) ya comparten raíz por la
      // unión transitiva vía A, así que union() no vuelve a fusionar nada
      // (rama "ya unidos" de union-find).
      const pointA = { latitude: -34.6037, longitude: -58.3816 };
      const pointB = { latitude: -34.6037 + 0.0003, longitude: -58.3816 };
      const pointC = { latitude: -34.6037, longitude: -58.3816 + 0.0003 };

      const candidates = [
        candidate({ emergencyId: 'A', userId: 'user-A', ...pointA }),
        candidate({ emergencyId: 'B', userId: 'user-B', ...pointB }),
        candidate({ emergencyId: 'C', userId: 'user-C', ...pointC }),
      ];

      const groups = groupNearbyEmergencies(candidates, { radiusMeters: 100, minUniqueCitizens: 3 });

      expect(groups).toHaveLength(1);
      expect(groups[0].slice().sort()).toEqual(['A', 'B', 'C']);
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
