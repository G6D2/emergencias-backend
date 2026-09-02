const { SignJWT } = require('jose');
const { randomUUID } = require('crypto');
const { ValidationError } = require('../errors/app-errors');
const { LOCAL_KEY_ID } = require('./local-keys');

function createLocalTokenIssuer(privateKey, config) {
  async function issueAccessToken({
    sub,
    preferred_username: preferredUsername,
    groups = [],
  }) {
    if (typeof sub !== 'string' || sub.trim().length === 0) {
      throw new ValidationError('sub is required');
    }

    if (!Array.isArray(groups)) {
      throw new ValidationError('groups must be an array');
    }

    const normalizedGroups = groups.filter((g) => typeof g === 'string');
    const username = typeof preferredUsername === 'string' && preferredUsername.length > 0
      ? preferredUsername
      : sub;

    const accessToken = await new SignJWT({
      aud: [config.audience],
      token_use: config.expectedTokenUse,
      ver: config.expectedVer,
      preferred_username: username,
      module: config.module,
      groups: normalizedGroups,
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: 'RS256', kid: LOCAL_KEY_ID })
      .setIssuer(config.issuer)
      .setSubject(sub.trim())
      .setIssuedAt()
      .setExpirationTime(`${config.tokenTtlSeconds}s`)
      .sign(privateKey);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.tokenTtlSeconds,
    };
  }

  return { issueAccessToken };
}

module.exports = { createLocalTokenIssuer };
