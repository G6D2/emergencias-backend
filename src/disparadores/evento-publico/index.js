const { Disparador } = require('../disparador');
const { ElevarPrioridad } = require('./respuestas/elevar-prioridad');

// Disparador de EventoComunitarioPublicado (Espacios Públicos).
// Regla inicial: todo evento público eleva la prioridad. TODO: definir los
// casos reales (capacidad, categoría, horario, ...) sobreescribiendo aplica().
class EventoPublicoDisparador extends Disparador {
  constructor() {
    super('EventoPublico');
  }

  respuestas(_evento) {
    return [new ElevarPrioridad()];
  }
}

module.exports = { EventoPublicoDisparador };
