// Agrupador de emergencias cercanas basado en DBSCAN (tarea #61, parte 2/2,
// ADR-002 "IncidentDetectionStrategy"). Módulo puro: no conoce Postgres ni
// Kafka. Recibe candidatos YA prefiltrados por quien lo llama (mismo
// emergencyType, dentro de la ventana temporal) y con lat/lng ya
// descifrados en memoria -- mismo contrato de entrada que RuleBasedGrouper.

const { DBSCAN } = require('density-clustering');
const { haversineDistanceMeters } = require('./rule-based-grouper');

/**
 * Agrupa emergencias cercanas entre sí usando DBSCAN (density-reachability
 * en cadena, misma semántica que RuleBasedGrouper -- ver el comentario en
 * rule-based-grouper.js sobre por qué ambas estrategias agrupan por cadena
 * y no por cercanía a un ancla fija).
 *
 * minPointsPerCluster de DBSCAN se pasa como `minUniqueCitizens` (decisión
 * confirmada del ADR): eso limita CANTIDAD DE REPORTES por cluster, no
 * ciudadanos únicos. Por eso hay un filtro posterior obligatorio: cualquier
 * cluster que no llegue a `minUniqueCitizens` USUARIOS ÚNICOS reales se
 * descarta completo, igual que en RuleBasedGrouper -- si no, un mismo
 * usuario podría formar un cluster "denso" a fuerza de reportes repetidos y
 * saltarse el invariante anti-spam.
 *
 * @param {Array<{ emergencyId: string, userId: string, latitude: number, longitude: number, createdAt: string|Date }>} candidates
 * @param {{ radiusMeters: number, minUniqueCitizens: number }} options
 * @returns {string[][]} grupos válidos (>= minUniqueCitizens ciudadanos distintos), cada uno un array de emergencyId
 */
// LIMITACION CONOCIDA: esta funcion y groupNearbyEmergencies comparten
// haversineDistanceMeters sin validar latitude/longitude -- un dato
// malformado rompe a las dos estrategias por igual, no solo a esta.
// El fallback del ADR-002 (Caso A) solo protege contra fallas propias
// de la libreria DBSCAN (ej. dataset no es un Array), no contra datos
// invalidos que lleguen desde findRecentByType. Evaluar agregar
// validacion explicita si esto se vuelve un problema real.
function groupNearbyEmergenciesDbscan(candidates, { radiusMeters, minUniqueCitizens }) {
  if (candidates.length === 0) return [];

  const dbscan = new DBSCAN();
  const clusters = dbscan.run(candidates, radiusMeters, minUniqueCitizens, haversineDistanceMeters);

  const groups = [];
  for (const memberIndices of clusters) {
    const members = memberIndices.map((index) => candidates[index]);
    const uniqueCitizens = new Set(members.map((member) => member.userId));
    if (uniqueCitizens.size >= minUniqueCitizens) {
      groups.push(members.map((member) => member.emergencyId));
    }
  }

  return groups;
}

module.exports = { groupNearbyEmergenciesDbscan };
