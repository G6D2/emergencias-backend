const {
  scrubFreeText,
  MAX_DESCRIPTION_LENGTH,
  PII_PATTERNS,
} = require('../security/pii-scrub');

// 32 KB es el tope de express.json en app.js: lo más largo que puede llegar
// en una description. Con el regex de email sin acotar tardaba ~0,7 s.
const HOSTILE_32KB = '1-'.repeat(16 * 1024);
const MAX_SCAN_MS = 50;

function elapsedMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

describe('scrubFreeText: ReDoS', () => {
  it('scrubs a 32 KB hostile input in a few ms', () => {
    expect(HOSTILE_32KB).toHaveLength(32 * 1024);

    let out;
    const ms = elapsedMs(() => {
      out = scrubFreeText(HOSTILE_32KB);
    });

    expect(ms).toBeLessThan(MAX_SCAN_MS);
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  it('keeps the email pattern linear even without the length cut', () => {
    const email = PII_PATTERNS.find(({ label }) => label === '[email]').re;

    const ms = elapsedMs(() => {
      email.lastIndex = 0;
      HOSTILE_32KB.replace(email, '[email]');
    });

    expect(ms).toBeLessThan(MAX_SCAN_MS);
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
