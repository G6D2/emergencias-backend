const fs = require('fs');
const path = require('path');
const { BusinessRule } = require('./business-rule');

const RULE_SUFFIX = '.rule.js';

// Carga las reglas de un listener: un archivo *.rule.js por regla, cada uno
// exportando una subclase de BusinessRule. Se instancian en orden alfabetico
// de archivo (prefijar con 01-, 02-... si el orden importa). Si la carpeta no
// existe, el listener no tiene reglas.
function loadRules(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(RULE_SUFFIX))
    .sort()
    .map((file) => {
      const exported = require(path.join(dir, file));
      const candidates = typeof exported === 'function' ? [exported] : Object.values(exported);
      const rules = candidates.filter((value) => typeof value === 'function' && value.prototype instanceof BusinessRule);
      if (rules.length !== 1) {
        throw new Error(`${file} debe exportar exactamente una subclase de BusinessRule (exporta ${rules.length})`);
      }
      const Rule = rules[0];
      return new Rule();
    });
}

module.exports = { loadRules, RULE_SUFFIX };
