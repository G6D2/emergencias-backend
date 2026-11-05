const path = require('path');
const fs = require('fs');

// Catálogo oficial de los 48 barrios de CABA (datos abiertos GCBA).
// Fuente: https://data.buenosaires.gob.ar/dataset/barrios
// Los nombres canónicos son los del campo BARRIO del dataset (mayúsculas).
const GEOJSON_PATH = path.join(__dirname, 'data', 'barrios-caba.geojson');

let cachedCatalog = null;

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;

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

/**
 * Punto-en-polígono contra el catálogo oficial. Fuera de CABA → null.
 */
function resolveBarrioFromPoint(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  for (const entry of loadCatalog().polygons) {
    if (pointInPolygon(lng, lat, entry.geometry)) {
      return entry.name;
    }
  }
  return null;
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
  // test hook
  _resetCatalogCache: () => { cachedCatalog = null; },
};
