// Vocabulario del contrato de Reclamos (docs/avro de su repo) que usan las
// reglas de este paquete.

// Estados en los que el reclamo ya no necesita que vaya nadie. Espacios lo
// deja en RESUELTO o RECHAZADO con IntervencionFinalizada; CERRADO llega
// después (a mano, o solo a los 7 días de RESUELTO).
const ESTADOS_FINALES = new Set(['RESUELTO', 'RECHAZADO', 'CERRADO']);

const CATEGORIA_TRANSITO = 'TRANSITO';
const OBJETO_CICLOVIA = 'CICLOVIA';

// "Ciclovía", " ciclovia " y "CICLOVIA" son lo mismo.
function normalizar(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

module.exports = { ESTADOS_FINALES, CATEGORIA_TRANSITO, OBJETO_CICLOVIA, normalizar };
