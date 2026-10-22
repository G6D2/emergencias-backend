// Respuesta: una acción concreta que produce un disparador (elevar prioridad,
// solicitar un recurso, ...). Cada respuesta implementa ejecutar(ctx); ctx es
// el mismo que recibe Disparador#responder (client de la tx del listener,
// metadata, causationId).
class Respuesta {
  constructor(nombre) {
    if (new.target === Respuesta) {
      throw new Error('Respuesta es abstracta: extender y definir ejecutar()');
    }
    this.nombre = nombre || new.target.name;
  }

  async ejecutar(_ctx) {
    throw new Error(`${this.nombre} debe definir ejecutar(ctx)`);
  }
}

module.exports = { Respuesta };
