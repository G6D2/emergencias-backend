// Payload de Espacios llevado a los nombres que leen las reglas de cobertura
// preventiva.
//
// Espacios publica las actividades como `ActividadCreada`:
//   actividadId, ubicacion { lat, lng }, fechaHoraInicio, fechaHoraFinalizacion
// y las reglas leen los nombres del contrato anterior (EventoComunitarioPublicado):
//   eventoId, latitud, longitud, inicio, fin
//
// Un campo que ya viene con el nombre de las reglas no se pisa, así que un
// mensaje con la forma anterior sigue funcionando igual. El resto del payload
// (titulo, capacidad, estado, direccion, correlationId...) pasa tal cual.
function primeroDefinido(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

function normalizarEventoEspacios(data) {
  if (!data || typeof data !== 'object') return {};
  const ubicacion = data.ubicacion && typeof data.ubicacion === 'object' ? data.ubicacion : {};
  const normalizado = {
    ...data,
    eventoId: primeroDefinido(data.eventoId, data.actividadId),
    latitud: primeroDefinido(data.latitud, ubicacion.lat, ubicacion.latitud),
    longitud: primeroDefinido(data.longitud, ubicacion.lng, ubicacion.longitud),
    inicio: primeroDefinido(data.inicio, data.fechaInicio, data.fechaHoraInicio),
    fin: primeroDefinido(data.fin, data.fechaFin, data.fechaHoraFinalizacion),
  };
  // Sin valor no se agrega la clave: las reglas distinguen "no vino".
  for (const key of ['eventoId', 'latitud', 'longitud', 'inicio', 'fin']) {
    if (normalizado[key] === undefined) delete normalizado[key];
  }
  return normalizado;
}

module.exports = { normalizarEventoEspacios };
