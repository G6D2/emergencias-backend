/**
 * Grupos del módulo Emergencias (CityPass+).
 * Nombres acordados con el delegado. La comparación ignora mayúsculas y
 * espacios de los costados (ver userHasGroup en authorize.js), sin otras
 * heurísticas sobre el nombre.
 */
const GROUPS = {
  CITIZEN: 'citizen',
  DISPATCHER: 'dispatcher',
  OFFICER: 'officer',
  // Delegado del módulo en el Login Federado: administra usuarios y grupos en
  // el panel del Grupo 2, pero no opera emergencias. Existe como grupo interno
  // solo para que GET /api/user lo informe (el front lo manda al panel del
  // Login Federado); no habilita ninguna ruta.
  DELEGATE: 'delegado',
};

module.exports = { GROUPS };
