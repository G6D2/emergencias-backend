const { EventoPublicoDisparador } = require('./evento-publico');

// Nombre corto del event type externo (mismo criterio que MapperRegistry)
// -> disparador. Sumar un disparador = una carpeta nueva + una línea acá.
function crearRegistroDisparadores() {
  return new Map([
    ['EventoComunitarioPublicado', new EventoPublicoDisparador()],
  ]);
}

module.exports = { crearRegistroDisparadores };
