const { ProgramarCoberturaPreventivaCommand } = require('../commands/programar-cobertura-preventiva');
const { EjecutarDisparadorCommand } = require('../commands/ejecutar-disparador');

// Mapper puro de EventoComunitarioPublicado (Espacios Publicos).
//
// Fuerzas:
// - capacidad = asistencia maxima esperada. Luciano la publica una vez en el
//   evento; usamos ese numero y no "inscriptos" (vale 0 al publicar porque
//   la gente se anota despues).
// - latitud/longitud son nullable con default null para espacios cargados
//   antes de que existieran coordenadas. Si faltan, la cobertura queda
//   requires_manual_validation=true (lo decide el comando) pero el evento
//   se mapea igual: no es nuestro criterio para no programarla.
// - umbral del lado de Emergencias: por debajo no se programa cobertura.
//
// Entrega: factory + funcion mapper. La factory recibe dependencias (umbral,
// locationCrypto) para que el mapper quede puro (recibe evento, devuelve
// comandos). Esto respeta el ADR #25: "los mappers no contienen reglas de
// negocio ni acceden a tablas".
//
// disparador (opcional): reglas de negocio propias de Emergencias para este
// evento (src/disparadores/evento-publico). Si viene, se emite siempre un
// EjecutarDisparadorCommand, independiente del umbral de cobertura.
function createEventoComunitarioPublicadoMapper({ umbralCapacidad, locationCrypto, userIdForExternal, disparador = null }) {
  if (!Number.isFinite(umbralCapacidad)) {
    throw new Error('createEventoComunitarioPublicadoMapper requiere umbralCapacidad (number)');
  }
  if (!locationCrypto) {
    throw new Error('createEventoComunitarioPublicadoMapper requiere locationCrypto');
  }

  return function mapEventoComunitarioPublicado({ metadata, data }) {
    const disparadorCommands = disparador
      ? [new EjecutarDisparadorCommand({ disparador, evento: { metadata, data } })]
      : [];

    const capacidadRaw = data && data.capacidad;
    const capacidad = Number.isFinite(capacidadRaw) ? capacidadRaw : 0;

    if (capacidad < umbralCapacidad) {
      return disparadorCommands;
    }

    const latitud = typeof data.latitud === 'number' ? data.latitud : null;
    const longitud = typeof data.longitud === 'number' ? data.longitud : null;

    // Cobertura primero: un disparador que eleve prioridad ya la ve creada
    // dentro de la misma transaccion.
    return [
      new ProgramarCoberturaPreventivaCommand({
        nombre: data.nombre,
        latitud,
        longitud,
        capacidad,
        causationEventId: metadata.eventId,
        locationCrypto,
        userIdForExternal,
      }),
      ...disparadorCommands,
    ];
  };
}

module.exports = { createEventoComunitarioPublicadoMapper };
