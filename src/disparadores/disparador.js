// Disparador: reacción de Emergencias a un evento de otro módulo.
//
// Template Method (en la línea del ADR "Generar respuestas predeterminadas
// con reglas y templates por recurso"): responder() fija el esqueleto común
// y cada disparador concreto define cuándo aplica y con qué respuestas.
// Cada disparador vive en su propia carpeta junto con sus respuestas, así
// sumar reglas de negocio no toca el listener ni los demás disparadores.
//
// Corre dentro de la transacción del listener (ADR #25): ctx trae el client,
// la metadata del evento y el causationId. Si una respuesta lanza, el
// listener hace ROLLBACK y Kafka reentrega el mensaje.
class Disparador {
  constructor(nombre) {
    if (new.target === Disparador) {
      throw new Error('Disparador es abstracto: extender y definir respuestas()');
    }
    this.nombre = nombre || new.target.name;
  }

  async responder(evento, ctx = {}) {
    if (!this.aplica(evento)) {
      return [];
    }

    const respuestas = this.respuestas(evento) || [];
    for (const respuesta of respuestas) {
      await respuesta.ejecutar(ctx);
    }
    return respuestas;
  }

  // Por defecto el disparador aplica a todo evento de su tipo. Una subclase
  // lo sobreescribe cuando la regla de negocio depende del contenido.
  aplica(_evento) {
    return true;
  }

  respuestas(_evento) {
    throw new Error(`${this.nombre} debe definir respuestas(evento)`);
  }
}

module.exports = { Disparador };
