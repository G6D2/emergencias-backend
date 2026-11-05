/** Longitud máxima de description libre en emergencias. */
const MAX_DESCRIPTION_LENGTH = 280;

/**
 * Antes de buscar PII el texto se corta a este múltiplo de maxLength: acota el
 * trabajo de los regex con cualquier entrada (el body admite hasta 32 KB) y
 * deja margen para que un dato que cruza el corte final se redacte entero en
 * vez de quedar la mitad a la vista (cortar en maxLength justo lo partiría).
 */
const SCAN_LENGTH_FACTOR = 4;

/**
 * Patrones típicos de PII en texto libre (AR / genérico).
 * Se reemplazan por placeholders para no persistir ni emitir datos sensibles.
 */
const PII_PATTERNS = [
  // Cuantificadores acotados (local ≤ 64, dominio ≤ 255, TLD ≤ 24): con `+` sin
  // tope, 32 KB de "1-1-1-..." tardaban ~0,7 s en backtracking (ReDoS).
  { re: /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}\b/gi, label: '[email]' },
  // CUIL/CUIT antes que teléfonos (si no, 20-12345678-9 queda como [tel]-9)
  { re: /\b\d{2}[-\s]?\d{7,8}[-\s]?\d\b/g, label: '[id]' },
  // Tarjeta (13–19 dígitos agrupados)
  { re: /\b(?:\d[ -]*?){13,19}\b/g, label: '[card]' },
  // Teléfonos AR / internacionales (7+ dígitos con separadores)
  { re: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}\b/g, label: '[tel]' },
];

/**
 * Sanitiza texto libre: normaliza espacios, redacta PII y trunca.
 * @param {unknown} raw
 * @param {{ maxLength?: number, fallback?: string }} [options]
 * @returns {string}
 */
function scrubFreeText(raw, options = {}) {
  const maxLength = options.maxLength ?? MAX_DESCRIPTION_LENGTH;
  const fallback = options.fallback ?? '';

  if (typeof raw !== 'string') return fallback;

  let text = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;

  text = text.slice(0, maxLength * SCAN_LENGTH_FACTOR);

  for (const { re, label } of PII_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, label);
  }

  if (text.length > maxLength) {
    text = text.slice(0, maxLength).trimEnd();
  }

  return text || fallback;
}

module.exports = {
  scrubFreeText,
  MAX_DESCRIPTION_LENGTH,
  PII_PATTERNS,
};
