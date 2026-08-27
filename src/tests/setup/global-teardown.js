const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.tmpdir(), 'emergencias-backend-test-db.json');

module.exports = async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  fs.unlinkSync(STATE_FILE);

  if (state.external) return;

  spawnSync('docker', ['rm', '-f', state.containerName]);
  spawnSync('docker', ['network', 'rm', state.networkName]);
};
