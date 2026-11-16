// Test de arquitectura (ADR "Consumir todos los eventos externos con un solo
// consumer"). El broker de EDA limita a 10 conexiones por IP y kafkajs abre 2
// por cada consumer o producer: cada llamada nueva a kafka.consumer() o
// kafka.producer() suma conexiones. Este test falla si alguien crea un
// cliente, un consumer, un producer o un admin de Kafka fuera de los lugares
// permitidos. Si un cambio necesita otro, primero se discute cuántas
// conexiones suma y se actualiza el ADR; recién ahí se agrega acá.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');

// patrón → archivos (relativos a src/) donde puede aparecer, y cuántas veces.
const RULES = [
  { name: 'new Kafka(', pattern: /\bnew\s+Kafka\s*\(/g, allowed: { 'services/kafka.service.js': 1 } },
  { name: '.consumer(', pattern: /\.consumer\s*\(/g, allowed: { 'listeners/event-consumer.js': 1 } },
  { name: '.producer(', pattern: /\.producer\s*\(/g, allowed: { 'services/kafka.service.js': 1 } },
  { name: '.admin(', pattern: /\.admin\s*\(/g, allowed: {} },
  { name: 'new EventConsumer(', pattern: /\bnew\s+EventConsumer\s*\(/g, allowed: { 'index.js': 1 } },
];

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'tests' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// Saca los comentarios para que una mención en un comentario no cuente.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function countByFile(files, pattern) {
  const counts = {};
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const matches = code.match(pattern);
    if (matches) counts[path.relative(SRC, file).split(path.sep).join('/')] = matches.length;
  }
  return counts;
}

describe('arquitectura: conexiones a Kafka', () => {
  const files = sourceFiles(SRC);

  it('encuentra el código fuente', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith(path.join('listeners', 'event-consumer.js')))).toBe(true);
  });

  it.each(RULES)('$name solo aparece donde está permitido', ({ pattern, allowed }) => {
    expect(countByFile(files, pattern)).toEqual(allowed);
  });

  it('stripComments ignora comentarios pero no URLs en strings', () => {
    expect(stripComments('// this.kafka.consumer()\nconst a = 1;')).not.toMatch(/\.consumer\(/);
    expect(stripComments('/* kafka.admin() */ x')).not.toMatch(/\.admin\(/);
    expect(stripComments("const u = 'https://x'; k.consumer()")).toMatch(/\.consumer\(/);
  });
});
