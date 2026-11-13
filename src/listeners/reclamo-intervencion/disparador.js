// Qué evento crea la intervención de un reclamo de ciclovía.
//
// El flujo del caso es Reclamos → Movilidad → Emergencias: Movilidad evalúa
// la obstrucción y, si corresponde, publica EmergenciaSolicitada. El alta
// directa por ReclamoCreado queda como plan B.
//
//   movilidad  solo EmergenciaSolicitada crea la intervención (default)
//   reclamo    solo ReclamoCreado la crea (lo que hacía el PR #93)
//   ambos      cualquiera de los dos, el primero que llegue; el otro la
//              encuentra creada y no duplica
//
// El cierre por ReclamoActualizado no depende de esto.
const ENV_VAR = 'RECLAMO_INTERVENCION_DISPARADOR';

const MOVILIDAD = 'movilidad';
const RECLAMO = 'reclamo';
const AMBOS = 'ambos';
const DISPARADORES = Object.freeze([MOVILIDAD, RECLAMO, AMBOS]);
const DEFAULT_DISPARADOR = MOVILIDAD;

// Vacío = default. Un valor que no existe falla en vez de caer al default: con
// un typo en "ambos" el plan B quedaría apagado sin que nadie se entere.
function resolveDisparador(raw) {
  if (raw === undefined || raw === null) return DEFAULT_DISPARADOR;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return DEFAULT_DISPARADOR;
  if (!DISPARADORES.includes(value)) {
    throw new Error(`${ENV_VAR} invalido: "${raw}" no es ${DISPARADORES.join(', ')}`);
  }
  return value;
}

// El de un listener: options.disparador (tests) o la variable de entorno. Se
// resuelve en el constructor, así un valor inválido frena el arranque (como
// EDA_CONSUMER_SINCE) en vez de descartar cada evento.
function disparadorDe(options = {}) {
  return resolveDisparador(options.disparador !== undefined ? options.disparador : process.env[ENV_VAR]);
}

function creaConReclamoCreado(disparador) {
  const vigente = resolveDisparador(disparador);
  return vigente === RECLAMO || vigente === AMBOS;
}

function creaConEmergenciaSolicitada(disparador) {
  const vigente = resolveDisparador(disparador);
  return vigente === MOVILIDAD || vigente === AMBOS;
}

module.exports = {
  ENV_VAR,
  MOVILIDAD,
  RECLAMO,
  AMBOS,
  DISPARADORES,
  DEFAULT_DISPARADOR,
  resolveDisparador,
  disparadorDe,
  creaConReclamoCreado,
  creaConEmergenciaSolicitada,
};
