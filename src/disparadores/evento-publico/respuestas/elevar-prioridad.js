const { Respuesta } = require('../../respuesta');

const MENSAJE = 'Elevo Prioridad porque hay un evento';

// Mock: todavía no definimos qué se eleva ni en qué casos.
class ElevarPrioridad extends Respuesta {
  constructor() {
    super('ElevarPrioridad');
  }

  async ejecutar(_ctx) {
    // TODO: efecto real (p. ej. contexto de zona del ADR "Elevar
    // temporalmente la prioridad con contextos de zona").
    console.log(MENSAJE);
  }
}

module.exports = { ElevarPrioridad, MENSAJE };
