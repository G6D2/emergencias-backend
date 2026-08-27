module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/src/tests/**/*.integration.test.js'],
  globalSetup: '<rootDir>/src/tests/setup/global-setup.js',
  globalTeardown: '<rootDir>/src/tests/setup/global-teardown.js',
  testTimeout: 30000,
};
