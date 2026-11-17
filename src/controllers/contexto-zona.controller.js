const { ValidationError } = require('../errors/app-errors');
const { CONTEXTO_TIPO } = require('../domain/contexto-zona');

const TIPOS_VALIDOS = Object.values(CONTEXTO_TIPO);

// Un contexto activo tal como lo muestra el banner del tablero. No expone el
// punto ni el radio de los eventos comunitarios: el banner es para las
// alertas por barrio.
// - tiposEmergencia null: eleva todos los tipos (evento comunitario).
// - tiposEmergencia []: no eleva nada (alerta LEVE o MEDIA).
function toContextoActivo(contexto) {
  const tiposEmergencia = Array.isArray(contexto.tiposEmergencia) ? contexto.tiposEmergencia : null;
  return {
    referenciaExterna: contexto.referenciaExterna,
    tipo: contexto.tipo,
    fenomeno: contexto.fenomeno ?? null,
    gravedad: contexto.gravedad ?? null,
    eleva: tiposEmergencia === null || tiposEmergencia.length > 0,
    tiposEmergencia,
    barrios: contexto.barrios ?? null,
    descripcion: contexto.descripcion ?? null,
    vigenteDesde: contexto.vigenteDesde,
    vigenteHasta: contexto.vigenteHasta,
  };
}

class ContextoZonaController {
  constructor(contextoZonaRepository) {
    this.contextoZonaRepository = contextoZonaRepository;
  }

  // GET /api/contextos-zona/activos[?tipo=ALERTA_CLIMATICA]
  async listActivos(query = {}) {
    let tipo = null;
    if (query.tipo !== undefined) {
      tipo = typeof query.tipo === 'string' ? query.tipo.trim().toUpperCase() : '';
      if (!TIPOS_VALIDOS.includes(tipo)) {
        throw new ValidationError(`tipo inválido: debe ser uno de ${TIPOS_VALIDOS.join(', ')}`);
      }
    }
    const contextos = await this.contextoZonaRepository.findActivos(null, { tipo });
    return { data: contextos.map(toContextoActivo) };
  }
}

module.exports = { ContextoZonaController, toContextoActivo };
