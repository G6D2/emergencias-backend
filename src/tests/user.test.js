const request = require('supertest');
const { createApp } = require('../app');

const mockKafkaService = {
  publishEvent: async () => {},
  checkHealth: async () => false,
};

const mockRepo = {
  create: async (e) => e,
  findById: async () => null,
  updateStatus: async () => ({}),
};

function stubAuthenticate(user) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

describe('GET /api/user', () => {
  it('returns current user groups from JWT', async () => {
    const app = createApp(mockKafkaService, mockRepo, {
      authenticate: stubAuthenticate({
        sub: 'U000042',
        username: 'jperez',
        groups: ['citizen'],
        module: 'emergencias',
      }),
    });

    const response = await request(app).get('/api/user').expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual({
      sub: 'U000042',
      username: 'jperez',
      groups: ['citizen'],
      module: 'emergencias',
    });
  });

  it('returns 401 without token', async () => {
    const { createAuthenticateMiddleware } = require('../auth/authenticate');
    const app = createApp(mockKafkaService, mockRepo, {
      authenticate: createAuthenticateMiddleware({
        config: {
          issuer: 'https://idp.citypass.local',
          audience: 'citypass-emergencias-api',
          jwksUri: 'https://idp.citypass.local/.well-known/jwks.json',
          clockTolerance: 60,
          expectedTokenUse: 'human',
          expectedVer: 1,
        },
        verifyAccessToken: async () => {
          throw new Error('no token');
        },
      }),
    });

    const response = await request(app).get('/api/user').expect(401);
    expect(response.body.error).toBe('UnauthorizedError');
  });
});
