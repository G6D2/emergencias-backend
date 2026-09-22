// DATOS SINTÉTICOS -- este script arma un escenario de ejemplo a mano
// para demostrar el mecanismo de agrupación y escalado. NO representa
// patrones reales de reportes de emergencias de ninguna ciudad.
//
// Standalone: no toca Postgres, no importa el repositorio real -- solo
// módulos de dominio puros (dbscan-grouper, rule-based-grouper, risk-engine).
// Correr con: node scripts/demo-dbscan.js

const { groupNearbyEmergenciesDbscan } = require('../src/domain/dbscan-grouper');
const { groupNearbyEmergencies, haversineDistanceMeters } = require('../src/domain/rule-based-grouper');
const { calculateIncidentScore, scoreToPriority, applyPriorityInvariant } = require('../src/domain/risk-engine');

const RADIUS_METERS = 300;
const MIN_UNIQUE_CITIZENS = 2;

// Obelisco (sintético), tres reportes de usuarios distintos a ~50-90m entre
// sí -- deberían agruparse como un mismo incidente de INCENDIO.
const BASE_POINT = { latitude: -34.6037, longitude: -58.3816 };

function candidate(overrides = {}) {
  return {
    emergencyId: 'e-default',
    userId: 'user-default',
    latitude: BASE_POINT.latitude,
    longitude: BASE_POINT.longitude,
    createdAt: new Date().toISOString(),
    severity: 'low',
    ...overrides,
  };
}

const incendioGroup = [
  candidate({
    emergencyId: 'incendio-e1', userId: 'user-A', severity: 'medium',
    latitude: BASE_POINT.latitude, longitude: BASE_POINT.longitude,
  }),
  candidate({
    emergencyId: 'incendio-e2', userId: 'user-B', severity: 'high',
    latitude: BASE_POINT.latitude + 0.0004, longitude: BASE_POINT.longitude,
  }),
  candidate({
    emergencyId: 'incendio-e3', userId: 'user-C', severity: 'low',
    latitude: BASE_POINT.latitude, longitude: BASE_POINT.longitude + 0.0006,
  }),
];

// Mismo usuario reportando dos veces, cerca -- caso anti-spam: no debe
// convertirse en incidente aunque DBSCAN los agrupe por densidad. Lejos del
// grupo de INCENDIO de arriba (offset grande) para que no se mezclen.
const sameUserSpam = [
  candidate({
    emergencyId: 'spam-e1', userId: 'user-D', severity: 'low',
    latitude: BASE_POINT.latitude + 0.02, longitude: BASE_POINT.longitude + 0.02,
  }),
  candidate({
    emergencyId: 'spam-e2', userId: 'user-D', severity: 'low',
    latitude: BASE_POINT.latitude + 0.0204, longitude: BASE_POINT.longitude + 0.02,
  }),
];

const dataset = [...incendioGroup, ...sameUserSpam];
const options = { radiusMeters: RADIUS_METERS, minUniqueCitizens: MIN_UNIQUE_CITIZENS };

console.log('=== Demo DbscanGrouper vs RuleBasedGrouper (dataset sintético) ===\n');
console.log(`Dataset: ${dataset.length} candidatos (3 de INCENDIO, usuarios distintos, cercanos; 2 del mismo usuario, cercanos entre sí).`);
console.log(`Parámetros: radiusMeters=${RADIUS_METERS}, minUniqueCitizens=${MIN_UNIQUE_CITIZENS}\n`);

const dbscanGroups = groupNearbyEmergenciesDbscan(dataset, options);
const ruleBasedGroups = groupNearbyEmergencies(dataset, options);

console.log('--- Resultado DbscanGrouper (estrategia primaria) ---');
console.log(JSON.stringify(dbscanGroups, null, 2));

console.log('\n--- Resultado RuleBasedGrouper (estrategia fallback) ---');
console.log(JSON.stringify(ruleBasedGroups, null, 2));

console.log('\n--- Verificación del invariante anti-spam ---');
const spamIds = new Set(sameUserSpam.map((c) => c.emergencyId));
const dbscanIncludesSpam = dbscanGroups.some((group) => group.some((id) => spamIds.has(id)));
const ruleBasedIncludesSpam = ruleBasedGroups.some((group) => group.some((id) => spamIds.has(id)));
console.log(`¿DbscanGrouper agrupó el par del mismo usuario? ${dbscanIncludesSpam} (esperado: false)`);
console.log(`¿RuleBasedGrouper agrupó el par del mismo usuario? ${ruleBasedIncludesSpam} (esperado: false)`);

console.log('\n=== Escalado de prioridad sobre el grupo de INCENDIO ===\n');

const [minDistanceMeters, maxDistanceMeters] = (() => {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < incendioGroup.length; i += 1) {
    for (let j = i + 1; j < incendioGroup.length; j += 1) {
      const distance = haversineDistanceMeters(incendioGroup[i], incendioGroup[j]);
      min = Math.min(min, distance);
      max = Math.max(max, distance);
    }
  }
  return [min, max];
})();

const factors = {
  reportCount: incendioGroup.length,
  uniqueCitizenCount: new Set(incendioGroup.map((c) => c.userId)).size,
  minDistanceMeters,
  maxDistanceMeters,
  recencyMinutes: 1, // los tres reportes son "recién ahora" en este dataset sintético
  maxSeverity: 'high', // el reporte de user-B
};

console.log('Factores calculados a mano sobre el grupo de INCENDIO:');
console.log(JSON.stringify(factors, null, 2));

const { score, reasonCodes } = calculateIncidentScore(factors);
const incidentPriority = scoreToPriority(score);

console.log(`\nScore del incidente: ${score}`);
console.log(`reasonCodes: ${JSON.stringify(reasonCodes)}`);
console.log(`Prioridad del incidente (scoreToPriority): ${incidentPriority}`);

console.log('\nPrioridad final por miembro (applyPriorityInvariant -- nunca baja de la individual):');
incendioGroup.forEach((member) => {
  const finalPriority = applyPriorityInvariant(member.severity, incidentPriority);
  console.log(`  ${member.emergencyId} (${member.userId}): individual=${member.severity} -> final=${finalPriority}`);
});
