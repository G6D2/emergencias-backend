const path = require('path');
const fs = require('fs');

// Catálogo oficial de los 48 barrios de CABA (datos abiertos GCBA).
// Fuente: https://data.buenosaires.gob.ar/dataset/barrios
// Los nombres canónicos son los del campo BARRIO del dataset (mayúsculas).
const GEOJSON_PATH = path.join(__dirname, 'data', 'barrios-caba.geojson');
// Si el punto cae en un hueco del GeoJSON simplificado, se asigna el barrio
// cuyo vértice más cercano esté a lo sumo NEAREST_BARRIO_MAX_METERS.
const NEAREST_BARRIO_MAX_METERS = 100;

let cachedCatalog = null;

function emptyCatalog() {
  return {
    names: Object.freeze([]),
    byKey: new Map(),
    polygons: [],
  };
}

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;

  try {
    const raw = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));
    const features = raw.features || [];
    const byKey = new Map();
    const polygons = [];

    for (const feature of features) {
      const name = feature.properties && feature.properties.barrio;
      if (!name || typeof name !== 'string') continue;
      const key = normalizeBarrioKey(name);
      byKey.set(key, name);
      polygons.push({ name, geometry: feature.geometry });
    }

    cachedCatalog = {
      names: Object.freeze([...byKey.values()].sort((a, b) => a.localeCompare(b, 'es'))),
      byKey,
      polygons,
    };
  } catch (error) {
    // No tumbar el alta de emergencias si falta/rompe el GeoJSON.
    cachedCatalog = emptyCatalog();
  }
  return cachedCatalog;
}

/**
 * Clave de comparación: mayúsculas, sin tildes, espacios colapsados.
 * "Nuñez" / "nunez" / "NUÑEZ" → misma clave.
 */
function normalizeBarrioKey(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function listBarrios() {
  return loadCatalog().names;
}

/**
 * Devuelve el nombre canónico del catálogo o null si no matchea.
 */
function matchBarrioFromText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const key = normalizeBarrioKey(value);
  if (!key) return null;
  return loadCatalog().byKey.get(key) || null;
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lng, lat, geometry) {
  if (!geometry || !geometry.coordinates) return false;
  const polys = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates
      : [];

  for (const poly of polys) {
    if (!poly.length) continue;
    if (!pointInRing(lng, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h += 1) {
      if (pointInRing(lng, lat, poly[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function iterOuterRings(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0] || []];
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((poly) => poly[0] || []);
  }
  return [];
}

/** Distancia del punto al vértice más cercano del polígono (metros). */
function minDistanceToGeometryMeters(lat, lng, geometry) {
  let min = Infinity;
  for (const ring of iterOuterRings(geometry)) {
    for (const coord of ring) {
      if (!coord || coord.length < 2) continue;
      const d = haversineMeters(lat, lng, coord[1], coord[0]);
      if (d < min) min = d;
    }
  }
  return min;
}

function resolveNearestBarrio(lat, lng, maxMeters = NEAREST_BARRIO_MAX_METERS) {
  let best = null;
  let bestDist = Infinity;
  for (const entry of loadCatalog().polygons) {
    const d = minDistanceToGeometryMeters(lat, lng, entry.geometry);
    if (d < bestDist) {
      bestDist = d;
      best = entry.name;
    }
  }
  if (best != null && bestDist <= maxMeters) return best;
  return null;
}

/**
 * Punto-en-polígono; si cae en un hueco del GeoJSON simplificado, el barrio
 * más cercano dentro de NEAREST_BARRIO_MAX_METERS. Fuera de CABA → null.
 */
function resolveBarrioFromPoint(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const hits = [];
  for (const entry of loadCatalog().polygons) {
    if (pointInPolygon(lng, lat, entry.geometry)) {
      hits.push(entry.name);
    }
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // Solapamiento: entre los que contienen el punto, el de vértice más cercano.
    let best = hits[0];
    let bestDist = Infinity;
    for (const entry of loadCatalog().polygons) {
      if (!hits.includes(entry.name)) continue;
      const d = minDistanceToGeometryMeters(lat, lng, entry.geometry);
      if (d < bestDist) {
        bestDist = d;
        best = entry.name;
      }
    }
    return best;
  }
  return resolveNearestBarrio(lat, lng);
}

/**
 * Política de derivación (ADR barrio en claro):
 * 1. Si hay coordenadas → PIP (ignora texto si discrepa).
 * 2. Si no hay coordenadas → texto solo si matchea el catálogo.
 * 3. Si no → null.
 */
function resolveBarrio({ latitude, longitude, barrioText } = {}) {
  const hasLocation = latitude !== null && latitude !== undefined
    && longitude !== null && longitude !== undefined
    && Number.isFinite(Number(latitude))
    && Number.isFinite(Number(longitude));

  if (hasLocation) {
    return resolveBarrioFromPoint(latitude, longitude);
  }

  return matchBarrioFromText(barrioText);
}

module.exports = {
  listBarrios,
  matchBarrioFromText,
  normalizeBarrioKey,
  resolveBarrioFromPoint,
  resolveBarrio,
  NEAREST_BARRIO_MAX_METERS,
  // test hook
  _resetCatalogCache: () => { cachedCatalog = null; },
};
