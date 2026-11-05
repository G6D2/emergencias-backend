#!/usr/bin/env node
// Valida asyncapi.yaml con el parser oficial. Sale con 1 si hay errores.
// Uso: npm run asyncapi:validate [-- ruta/al/spec.yaml]
const fs = require('fs');
const path = require('path');
const { Parser } = require('@asyncapi/parser');

const SEVERITY = ['error', 'warning', 'info', 'hint'];

async function main() {
  const specPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'asyncapi.yaml'));
  const { document, diagnostics } = await new Parser().parse(fs.readFileSync(specPath, 'utf8'));
  for (const d of diagnostics) {
    console.log(`${SEVERITY[d.severity] || d.severity}  ${d.path.join('.') || '(root)'}  ${d.message}`);
  }
  const errors = diagnostics.filter((d) => d.severity === 0);
  if (!document || errors.length > 0) {
    console.error(`\n${specPath}: ${errors.length} error(es)`);
    process.exit(1);
  }
  console.log(`\n${specPath}: OK (AsyncAPI ${document.version()}, ${document.channels().length} channels, ${document.operations().length} operations)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
