const { generateKeyPair, exportJWK, importPKCS8 } = require('jose');

const LOCAL_KEY_ID = 'emergencias-local-dev';

/**
 * Claves RSA locales para AUTH_MODE=local.
 * Misma validación RS256 que el IdP real; solo cambia quién firma.
 */
async function createLocalKeySet(privateKeyPem = null) {
  let privateKey;
  let publicKey;

  if (privateKeyPem) {
    privateKey = await importPKCS8(privateKeyPem, 'RS256');
    publicKey = privateKey;
  } else {
    ({ privateKey, publicKey } = await generateKeyPair('RS256'));
  }

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = LOCAL_KEY_ID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  return {
    privateKey,
    publicJwk,
    kid: LOCAL_KEY_ID,
  };
}

module.exports = { createLocalKeySet, LOCAL_KEY_ID };
