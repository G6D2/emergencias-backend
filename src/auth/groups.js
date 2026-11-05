/**
 * Grupos del módulo Emergencias (CityPass+).
 * Nombres acordados con el delegado — comparación literal, sin heurísticas.
 */
const GROUPS = {
  CITIZEN: 'citizen',
  DISPATCHER: 'dispatcher',
  OFFICER: 'officer',
};

/**
 * Mapa grupo → permisos del módulo. Grupo desconocido no otorga nada.
 */
const GROUP_PERMISSIONS = {
  [GROUPS.CITIZEN]: [
    'panic-button:create',
    'emergency:read-own',
    'emergency:cancel-own',
  ],
  [GROUPS.DISPATCHER]: [
    'emergency:read-all',
  ],
  [GROUPS.OFFICER]: [
    'emergency:update-status-assigned',
  ],
};

module.exports = { GROUPS, GROUP_PERMISSIONS };
