// Envelope de los eventos de alerta climática de Espacios.
//
// El gateway entrega `{ metadata, data }`, pero el ejemplo de Espacios trae
// eventId, eventType, occurredAt y source en la raíz y solo `data` anidado.
// Se aceptan las dos formas. Sin esto, la deduplicación (OutcomeFactory, por
// metadata.eventId) no encuentra el eventId.
const CAMPOS_METADATA_EN_RAIZ = ['eventId', 'eventType', 'occurredAt', 'source', 'timestamp'];

function esObjeto(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function normalizarEnvelope(event) {
  const raw = esObjeto(event) ? event : {};
  let metadata;
  if (esObjeto(raw.metadata)) {
    metadata = raw.metadata;
  } else {
    metadata = {};
    for (const campo of CAMPOS_METADATA_EN_RAIZ) {
      if (raw[campo] !== undefined) metadata[campo] = raw[campo];
    }
  }
  return { metadata, data: esObjeto(raw.data) ? raw.data : {} };
}

module.exports = { normalizarEnvelope };
