const path = require('path');
const { loadRules } = require('../../listeners/load-rules');
const { BusinessRule } = require('../../listeners/business-rule');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

describe('loadRules', () => {
  it('instancia cada *.rule.js en orden alfabetico e ignora el resto', () => {
    const rules = loadRules(fixture('rules'));
    expect(rules.map((r) => r.constructor.name)).toEqual(['CapacidadAlta', 'Siempre']);
    rules.forEach((r) => expect(r).toBeInstanceOf(BusinessRule));
  });

  it('carpeta sin reglas o inexistente => sin reglas', () => {
    expect(loadRules(fixture('rules-vacias'))).toEqual([]);
    expect(loadRules(fixture('no-existe'))).toEqual([]);
  });

  it('falla si un *.rule.js no exporta una subclase de BusinessRule', () => {
    expect(() => loadRules(fixture('rules-invalidas'))).toThrow(
      /sin-regla.rule.js debe exportar exactamente una subclase de BusinessRule \(exporta 0\)/
    );
  });

  it('acepta una subclase exportada directamente (module.exports = Clase)', () => {
    const [rule] = loadRules(fixture('rules-export-directo'));
    expect(rule.constructor.name).toBe('Directa');
  });
});
