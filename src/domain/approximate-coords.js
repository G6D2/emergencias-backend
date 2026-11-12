// Coordenadas aproximadas de una emergencia: redondeadas a COORD_DECIMALS
// (~100 m). Ubican la cuadra, no el domicilio. Son las que viajan en claro en
// el bus (ADR "Publicar coordenadas aproximadas en claro en los eventos del
// bus") y las que se guardan en emergencies.latitud_aprox/longitud_aprox para
// medir la distancia a un contexto de zona sin descifrar la ubicación exacta.

const COORD_DECIMALS = 3;

function roundCoord(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

// Las dos o ninguna: un par incompleto no ubica nada.
function approximateCoords({ latitude, longitude } = {}) {
  const latitud = roundCoord(latitude);
  const longitud = roundCoord(longitude);
  if (latitud === null || longitud === null) return { latitud: null, longitud: null };
  return { latitud, longitud };
}

module.exports = { COORD_DECIMALS, roundCoord, approximateCoords };
