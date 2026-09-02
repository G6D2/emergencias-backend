const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Emergencias Backend API',
      version: '0.1.0',
      description:
        'API del módulo de Emergencias y Seguridad (CityPass+). Botón de pánico y cambios de estado de emergencies.',
    },
    servers: [
      {
        url: 'http://localhost:{port}',
        description: 'Local',
        variables: {
          port: {
            default: '3000',
          },
        },
      },
    ],
    tags: [
      { name: 'Health', description: 'Estado del servicio' },
      { name: 'Panic Button', description: 'Activación y consulta de botón de pánico' },
      { name: 'Emergencies', description: 'Cambios de estado de emergencias' },
    ],
    components: {
      schemas: {
        Location: {
          type: 'object',
          required: ['latitude', 'longitude'],
          properties: {
            latitude: { type: 'number', example: -34.6037 },
            longitude: { type: 'number', example: -58.3816 },
          },
        },
        Emergency: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', example: 'user-123' },
            latitude: { type: 'number', example: -34.6037 },
            longitude: { type: 'number', example: -58.3816 },
            description: { type: 'string' },
            severity: { type: 'string', example: 'critical' },
            status: {
              type: 'string',
              enum: [
                'PENDING',
                'VALIDATED',
                'DISPATCHED',
                'EN_ROUTE',
                'ON_SCENE',
                'RESOLVED',
                'CLOSED',
                'CANCELLED',
                'DISCARDED',
              ],
              example: 'PENDING',
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        PanicButtonRequest: {
          type: 'object',
          required: ['userId', 'location'],
          properties: {
            userId: { type: 'string', example: 'user-123' },
            location: { $ref: '#/components/schemas/Location' },
            description: {
              type: 'string',
              example: 'Necesito ayuda inmediata',
            },
            severity: {
              type: 'string',
              example: 'critical',
              default: 'critical',
            },
          },
        },
        PanicButtonResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            emergencyId: { type: 'string', format: 'uuid' },
            message: { type: 'string', example: 'Botón de pánico activado' },
            data: { $ref: '#/components/schemas/Emergency' },
          },
        },
        CancelEmergencyRequest: {
          type: 'object',
          properties: {
            actor: { type: 'string', nullable: true, example: 'user-123' },
            reason: { type: 'string', nullable: true, example: 'Falsa alarma' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'ValidationError' },
            message: { type: 'string' },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
            kafka: {
              type: 'string',
              enum: ['connected', 'disconnected'],
              example: 'connected',
            },
          },
        },
      },
    },
  },
  apis: [
    './src/app.js',
    './src/routes/*.js',
  ],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = { swaggerSpec };
