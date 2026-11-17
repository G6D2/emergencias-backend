const { CONTEXTO_TIPO } = require('../domain/contexto-zona');
const { resumirAlertasActivas } = require('../domain/alerta-climatica');

// Banner de alertas climáticas del tablero del dispatcher. Solo lee los
// contextos ALERTA_CLIMATICA que crea el listener de la alerta (ADR "Responder
// a las alertas climáticas de Espacios"): no publica nada ni cambia la
// prioridad. Los eventos de espacios públicos no se listan acá: su motivo ya
// se ve en priorityContext de cada emergencia.
class ContextoZonaController {
  constructor(contextoZonaRepository) {
    this.contextoZonaRepository = contextoZonaRepository;
  }

  // GET /api/contextos-zona/activos: una entrada por alerta (no por punto).
  async listActivos() {
    const contextos = await this.contextoZonaRepository.findActivos(null, {
      tipo: CONTEXTO_TIPO.ALERTA_CLIMATICA,
    });
    return { data: resumirAlertasActivas(contextos) };
  }
}

module.exports = { ContextoZonaController };
