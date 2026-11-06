const {
  scrubFreeText,
  MAX_DESCRIPTION_LENGTH,
  PII_PATTERNS,
} = require('../security/pii-scrub');

// 32 KB es el tope de express.json en app.js: lo más largo que puede llegar
// en una description. Con el regex de email sin acotar, cada pasada sobre esta
// entrada tardaba ~0,7 s.
const HOSTILE_32KB = '1-'.repeat(16 * 1024);
// scrubFreeText completo: ~1 ms en local.
const SCRUB_MAX_MS = 50;
// Regex de email solo, sin el corte previo: ~7 ms en local. El margen absorbe
// la carga de los workers de Jest corriendo en paralelo (en la suite completa
// se vio 70 ms) y sigue muy por debajo de los ~700 ms de la versión sin acotar.
const EMAIL_REGEX_MAX_MS = 150;

// Mejor de 3 corridas: descarta picos de GC o de scheduling que no tienen
// nada que ver con el regex.
function fastestMs(fn) {
  const runs = [0, 1, 2].map(() => {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  });
  return Math.min(...runs);
}

describe('scrubFreeText: ReDoS', () => {
  it('scrubs a 32 KB hostile input in a few ms', () => {
    expect(HOSTILE_32KB).toHaveLength(32 * 1024);

    let out;
    const ms = fastestMs(() => {
      out = scrubFreeText(HOSTILE_32KB);
    });

    expect(ms).toBeLessThan(SCRUB_MAX_MS);
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  it('keeps the email pattern linear even without the length cut', () => {
    const email = PII_PATTERNS.find(({ label }) => label === '[email]').re;

    const ms = fastestMs(() => {
      email.lastIndex = 0;
      HOSTILE_32KB.replace(email, '[email]');
    });

    expect(ms).toBeLessThan(EMAIL_REGEX_MAX_MS);
  });
});

describe('scrubFreeText: length cut before scanning', () => {
  it('redacts an email that crosses the final cut instead of leaving half of it', () => {
    const text = `${'a'.repeat(MAX_DESCRIPTION_LENGTH - 10)} juan.perez@gmail.com`;

    const out = scrubFreeText(text);

    expect(out).toContain('[email]');
    expect(out).not.toContain('juan.perez');
  });

  it('still redacts usual emails, including subdomains and long TLDs', () => {
    const out = scrubFreeText('Avisar a ana.gomez+sos@correo.buenosaires.gob.ar o a x@y.museum');

    expect(out).toBe('Avisar a [email] o a [email]');
  });

  it('respects a custom maxLength', () => {
    const out = scrubFreeText(`${'x'.repeat(50)} vecino@mail.com ${'y'.repeat(50)}`, { maxLength: 60 });

    expect(out).toHaveLength(60);
    expect(out).toContain('[email]');
  });
});
