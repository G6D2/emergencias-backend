// Agrupador determinístico de emergencias cercanas (tarea #60, parte 1/2).
// Módulo puro: no conoce Postgres ni Kafka. Recibe candidatos YA prefiltrados
// por quien lo llama (mismo emergencyType, dentro de la ventana temporal) y
// con lat/lng ya descifrados en memoria.

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Distancia entre dos puntos geográficos en metros (fórmula de Haversine).
 * @param {{ latitude: number, longitude: number }} pointA
 * @param {{ latitude: number, longitude: number }} pointB
 */
function haversineDistanceMeters(pointA, pointB) {
  const deltaLat = toRadians(pointB.latitude - pointA.latitude);
  const deltaLon = toRadians(pointB.longitude - pointA.longitude);
  const latA = toRadians(pointA.latitude);
  const latB = toRadians(pointB.latitude);

  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

// Union-Find liviano: cada candidato empieza en su propio conjunto, y se
// fusiona con cualquier otro candidato a <= radiusMeters de distancia.
function find(parents, index) {
  let current = index;
  while (parents[current] !== current) {
    parents[current] = parents[parents[current]];
    current = parents[current];
  }
  return current;
}

function union(parents, a, b) {
  const rootA = find(parents, a);
  const rootB = find(parents, b);
  if (rootA !== rootB) parents[rootA] = rootB;
}

/**
 * Agrupa emergencias cercanas entre sí por transitividad de distancia
 * (clustering por componentes conexas, no solo pares): si A está cerca de B
 * y B está cerca de C, las tres caen en el mismo grupo aunque A y C no estén
 * dentro del radio entre sí.
 *
 * Esto es INTENCIONAL, no un descuido: agrupar por cadena (reachability
 * transitiva) en vez de por cercanía a un punto ancla común es la misma
 * semántica que usa DBSCAN, la estrategia de ML que va a implementar este
 * mismo contrato (IncidentDetectionStrategy) en el Sprint 3-4 — DBSCAN
 * también conecta puntos por "density-reachability" en cadena, no por
 * distancia a un centro fijo. Si esta implementación agrupara por cercanía
 * a un ancla y DBSCAN agrupara por cadena, ambas estrategias darían
 * resultados distintos para el mismo escenario de entrada, y el fallback
 * entre una y otra dejaría de ser predecible para quien consume el
 * contrato. No cambiar este criterio sin coordinar con esa migración.
 *
 * @param {Array<{ emergencyId: string, userId: string, latitude: number, longitude: number, createdAt: string|Date }>} candidates
 * @param {{ radiusMeters: number, minUniqueCitizens: number }} options
 * @returns {string[][]} grupos válidos (>= minUniqueCitizens ciudadanos distintos), cada uno un array de emergencyId
 */
function groupNearbyEmergencies(candidates, { radiusMeters, minUniqueCitizens }) {
  const parents = candidates.map((_candidate, index) => index);

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const distance = haversineDistanceMeters(candidates[i], candidates[j]);
      if (distance <= radiusMeters) {
        union(parents, i, j);
      }
    }
  }

  const clusters = new Map();
  candidates.forEach((candidate, index) => {
    const root = find(parents, index);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(candidate);
  });

  const groups = [];
  for (const members of clusters.values()) {
    const uniqueCitizens = new Set(members.map((member) => member.userId));
    if (uniqueCitizens.size >= minUniqueCitizens) {
      groups.push(members.map((member) => member.emergencyId));
    }
  }

  return groups;
}

module.exports = { groupNearbyEmergencies, haversineDistanceMeters };
