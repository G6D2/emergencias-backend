const { EmergenciaBicicletaListener } = require('./emergencia-bicicleta/emergencia-bicicleta.listener');

module.exports = {
  EmergenciaBicicletaListener,
  listeners: [EmergenciaBicicletaListener],
};
