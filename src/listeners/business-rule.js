// Regla de negocio abstracta que evalua un listener.
//
// Cada regla decide si aplica al evento (appliesTo) y, si aplica, devuelve
// un resultado (apply) con la forma { type, payload }. Los resultados son la
// salida del listener: los va a consumir una factory que, segun el type,
// arma los POST y las escrituras en base de cada caso de negocio. Las reglas
// no tienen side effects.
class BusinessRule {
  constructor() {
    if (new.target === BusinessRule) {
      throw new Error('BusinessRule es abstracta: extender e implementar appliesTo() y apply()');
    }
  }

  // eslint-disable-next-line no-unused-vars
  appliesTo(context) {
    throw new Error(`${this.constructor.name} debe implementar appliesTo(context)`);
  }

  // eslint-disable-next-line no-unused-vars
  apply(context) {
    throw new Error(`${this.constructor.name} debe implementar apply(context)`);
  }
}

module.exports = { BusinessRule };
