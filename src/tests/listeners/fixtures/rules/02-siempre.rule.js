const { BusinessRule } = require('../../../../listeners/business-rule');

class Siempre extends BusinessRule {
  appliesTo() {
    return true;
  }

  apply() {
    return { type: 'Siempre', payload: {} };
  }
}

module.exports = { Siempre };
