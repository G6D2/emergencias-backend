const request = require('supertest');
const app = require('../index');

describe('Panic Button API', () => {
  describe('POST /api/panic-button', () => {
    it('should trigger panic button successfully', async () => {
      const payload = {
        userId: 'user-123',
        location: {
          lat: -34.6037,
          lng: -58.3816,
        },
        description: 'Test panic button',
      };

      const response = await request(app)
        .post('/api/panic-button')
        .send(payload)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.emergencyId).toBeDefined();
      expect(response.body.data.userId).toBe(payload.userId);
    });

    it('should fail without required fields', async () => {
      const payload = {
        description: 'Missing userId and location',
      };

      const response = await request(app)
        .post('/api/panic-button')
        .send(payload)
        .expect(500);

      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /api/panic-button/:id', () => {
    it('should retrieve panic button event', async () => {
      // First create an emergency
      const createResponse = await request(app)
        .post('/api/panic-button')
        .send({
          userId: 'user-456',
          location: { lat: -34.6037, lng: -58.3816 },
        });

      const emergencyId = createResponse.body.emergencyId;

      // Then retrieve it
      const getResponse = await request(app)
        .get(`/api/panic-button/${emergencyId}`)
        .expect(200);

      expect(getResponse.body.success).toBe(true);
      expect(getResponse.body.data.id).toBe(emergencyId);
    });
  });
});
