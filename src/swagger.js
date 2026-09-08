const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Emergencias Backend API',
      version: '0.1.0',
      description:
        'API del módulo de Emergencias y Seguridad (CityPass+). Botón de pánico y cambios de estado de emergencies. Autenticación vía JWT del IdP CityPass+.',
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
      { name: 'User', description: 'Perfil del usuario autenticado' },
      { name: 'Dev Auth', description: 'Login de desarrollo (solo AUTH_MODE=local)' },
      { name: 'Panic Button', description: 'Activación y consulta de botón de pánico' },
      { name: 'Emergencies', description: 'Cambios de estado de emergencias' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token CityPass+ (Authorization: Bearer <token>)',
        },
      },
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
            userId: { type: 'string', example: 'U000042', description: 'Claim sub del JWT' },
            latitude: { type: 'number', nullable: true, example: -34.6037 },
            longitude: { type: 'number', nullable: true, example: -58.3816 },
            locationAnonymized: {
              type: 'boolean',
              example: false,
              description: 'true si la ubicación fue borrada por política de retención',
            },
            description: { type: 'string' },
            severity: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              example: 'critical',
            },
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
          required: ['location'],
          properties: {
            location: { $ref: '#/components/schemas/Location' },
            description: {
              type: 'string',
              example: 'Necesito ayuda inmediata',
            },
            severity: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
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
            reason: { type: 'string', nullable: true, example: 'Falsa alarma' },
          },
        },
        DiscardEmergencyRequest: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 1, example: 'Reporte inválido' },
          },
        },
        DevLoginRequest: {
          type: 'object',
          required: ['sub'],
          properties: {
            sub: { type: 'string', example: 'U000042', description: 'Identificador estable del usuario' },
            preferred_username: { type: 'string', example: 'jperez' },
            groups: {
              type: 'array',
              items: { type: 'string' },
              example: ['citizen'],
            },
          },
        },
        CurrentUserResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                sub: { type: 'string', example: 'U000042' },
                username: { type: 'string', example: 'jperez' },
                groups: {
                  type: 'array',
                  items: { type: 'string' },
                  example: ['citizen'],
                },
                module: { type: 'string', example: 'emergencias' },
              },
            },
          },
        },
        DevLoginResponse: {
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            token_type: { type: 'string', example: 'Bearer' },
            expires_in: { type: 'integer', example: 900 },
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
            authMode: {
              type: 'string',
              enum: ['local', 'idp'],
              example: 'local',
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
