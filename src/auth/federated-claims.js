const { GROUPS } = require('./groups');

/**
 * Traducción de los claims del Login Federado (Grupo 2) a la identidad
 * interna del módulo: grupos federados → grupos internos (IDP_GROUP_MAP) y
 * sub federado → id interno (IDP_SUB_ALIASES). Solo se usa en AUTH_MODE=hybrid.
 *
 * Todo se valida al arrancar (loadAuthConfig): un JSON roto o un grupo interno
 * que no existe tumba el boot en vez de dejar a alguien sin acceso, o con uno
 * que no le corresponde, en silencio.
 */

const INTERNAL_GROUPS = new Set(Object.values(GROUPS));

/**
 * Mapa por default: los mismos nombres que reconoce el front
 * (app/lib/auth-roles.js de G6D2/Frontend), así front y back coinciden en qué
 * es cada persona. Sin `citizen` a propósito: en hybrid los ciudadanos entran
 * con cuenta local, y como local y federado comparten el espacio de `sub`
 * (el contrato del Grupo 2 usa subs como 'U000042', que también es un sub
 * demo local), un federado con `citizen` podría ver emergencias de un
 * ciudadano local con el mismo sub. Si hace falta, se agrega con IDP_GROUP_MAP.
 */
const DEFAULT_IDP_GROUP_MAP = Object.freeze({
  dispatcher: [GROUPS.DISPATCHER],
  dispatchers: [GROUPS.DISPATCHER],
  operador: [GROUPS.DISPATCHER],
  officer: [GROUPS.OFFICER],
  delegado: [GROUPS.DELEGATE],
  delegados: [GROUPS.DELEGATE],
});

function normalizeGroupName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function parseJsonObject(raw, name) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed;
}

function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

/**
 * IDP_GROUP_MAP: {"grupo-federado": "grupo-interno" | ["interno", ...]}.
 * Las claves ignoran mayúsculas. Si está definido REEMPLAZA al default (no se
 * mezcla), así lo que se lee en Render es todo lo que vale. `[]` declara un
 * grupo conocido que no habilita nada.
 *
 * @returns {Map<string, string[]>} grupo federado normalizado → grupos internos
 */
function parseGroupMap(raw) {
  const source = isBlank(raw) ? DEFAULT_IDP_GROUP_MAP : parseJsonObject(raw, 'IDP_GROUP_MAP');
  const map = new Map();

  for (const [federated, internal] of Object.entries(source)) {
    const key = normalizeGroupName(federated);
    if (!key) {
      throw new Error('IDP_GROUP_MAP has an empty group name');
    }
    const targets = Array.isArray(internal) ? internal : [internal];
    if (targets.some((target) => !INTERNAL_GROUPS.has(target))) {
      throw new Error(
        `IDP_GROUP_MAP["${federated}"] must map to one of: ${[...INTERNAL_GROUPS].join(', ')}`
      );
    }
    map.set(key, [...new Set([...(map.get(key) || []), ...targets])]);
  }

  return map;
}

/**
 * IDP_SUB_ALIASES: {"sub-federado": "id-interno"}. Pensado para oficiales: el
 * id interno es el del catálogo (`of-001`), que es lo que guarda
 * emergencies.assigned_officer_id. Las claves se comparan tal cual.
 *
 * @returns {Map<string, string>}
 */
function parseSubAliases(raw) {
  const aliases = new Map();
  if (isBlank(raw)) {
    return aliases;
  }

  for (const [federatedSub, internalId] of Object.entries(parseJsonObject(raw, 'IDP_SUB_ALIASES'))) {
    if (!federatedSub.trim() || typeof internalId !== 'string' || !internalId.trim()) {
      throw new Error('IDP_SUB_ALIASES must map non-empty subs to non-empty internal ids');
    }
    aliases.set(federatedSub, internalId.trim());
  }

  return aliases;
}

/**
 * Grupos internos de una persona federada. Los que el mapa no conoce no
 * otorgan nada (contrato del Grupo 2: "grupo desconocido = no otorga nada").
 */
function mapFederatedGroups(idpGroups, groupMap) {
  const internal = new Set();
  for (const group of idpGroups) {
    for (const target of groupMap.get(normalizeGroupName(group)) || []) {
      internal.add(target);
    }
  }
  return [...internal];
}

/**
 * Aplica IDP_SUB_ALIASES a una identidad ya verificada. Solo toca tokens del
 * Login Federado: un token local con el mismo sub sigue siendo quien es.
 * El sub original queda en `idpSub` para logs y para GET /api/user.
 */
function applySubAlias(user, aliases) {
  if (!user || user.authSource !== 'federated' || !aliases || aliases.size === 0) {
    return user;
  }
  const internalId = aliases.get(user.idpSub ?? user.sub);
  if (!internalId) {
    return user;
  }
  return { ...user, sub: internalId };
}

module.exports = {
  DEFAULT_IDP_GROUP_MAP,
  parseGroupMap,
  parseSubAliases,
  mapFederatedGroups,
  applySubAlias,
};
