// correlationId que llega en un evento externo (issue #77 del board). Se
// conserva tal cual aunque no sea UUID: la columna es TEXT desde V32 y los
// otros módulos mandan sus propios ids (`evento-<id>` y `act-<id>` de
// Espacios, `EMG-...` de Movilidad).
//
// Solo se descarta lo que no sirve para correlacionar: un valor que no es
// string, vacío o con solo espacios, más largo que MAX_CORRELATION_ID_LENGTH
// o con caracteres de control (un salto de línea partiría un log). En ese
// caso devuelve null y el caller usa el id propio de la emergencia, como
// antes.
const MAX_CORRELATION_ID_LENGTH = 128;
const CARACTER_DE_CONTROL = /\p{Cc}/u;

function correlationIdExterno(value) {
  if (typeof value !== 'string') return null;
  if (value.trim() === '' || value.length > MAX_CORRELATION_ID_LENGTH) return null;
  if (CARACTER_DE_CONTROL.test(value)) return null;
  return value;
}

module.exports = { MAX_CORRELATION_ID_LENGTH, correlationIdExterno };
