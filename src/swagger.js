const swaggerJsdoc = require('swagger-jsdoc');
const { EMERGENCY_STATUSES } = require('./domain/emergency-status');
const { EMERGENCY_TYPES } = require('./domain/emergency-type');

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
      { name: 'Emergencies', description: 'Listado, detalle y cambios de estado de emergencias' },
      { name: 'Officers', description: 'Catálogo de oficiales para asignación (dispatcher)' },
      { name: 'Incidents', description: 'Resultado del motor de detección de incidentes (dispatcher)' },
      { name: 'CitizenProfile', description: 'Perfil personal y ubicaciones frecuentes del ciudadano' },
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
            correlationId: {
              type: 'string',
              format: 'uuid',
              description: 'Igual al id al crear (ADR-001). Traza creación → priorización → despacho en los eventos.',
            },
            userId: { type: 'string', example: 'U000042', description: 'Claim sub del JWT' },
            latitude: { type: 'number', nullable: true, example: -34.6037 },
            longitude: { type: 'number', nullable: true, example: -58.3816 },
            address: {
              type: 'string',
              nullable: true,
              example: 'Av. Corrientes 1234, CABA',
              description: 'Dirección legible provista al reportar (opcional). null si no se '
                + 'proveyó, o cuando la ubicación está anonimizada o no pudo descifrarse '
                + '(mismo criterio que latitude/longitude).',
            },
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
              description: 'Derivada de emergencyType por el backend (severityForType), no la elige quien reporta.',
            },
            emergencyType: {
              type: 'string',
              enum: [...EMERGENCY_TYPES],
              example: 'PANICO',
              description: 'Catálogo cerrado. PANICO es el botón SOS (sin categoría declarada).',
            },
            status: {
              type: 'string',
              enum: [...EMERGENCY_STATUSES],
              example: 'PENDING',
            },
            causasRelacionadas: {
              type: 'array',
              items: { type: 'string', enum: ['VIA', 'ESPACIO_PUBLICO', 'RESIDUOS'] },
              default: [],
              description: 'Causas declaradas por el oficial al resolver la emergencia.',
            },
            assignedOfficerId: {
              type: 'string',
              nullable: true,
              example: null,
              description: 'Oficial asignado (null hasta el despacho)',
            },
            locationUnavailable: {
              type: 'boolean',
              example: false,
              description: 'true si la ubicación cifrada no pudo descifrarse con la clave actual',
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            closedAt: { type: 'string', format: 'date-time', nullable: true },
            incident: {
              allOf: [{ $ref: '#/components/schemas/IncidentSummary' }],
              nullable: true,
              description: 'Incidente al que fue agrupada esta emergencia (motor de detección de '
                + 'incidentes, corre cada 60s), o null si todavía no fue agrupada a ninguno. '
                + 'SOLO en la respuesta al dispatcher: un citizen nunca recibe este campo '
                + '(no se filtra información operativa a quien reporta).',
            },
            effectivePriority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              example: 'critical',
              description: 'Máximo entre severity y incident.priority (nunca menor a severity). '
                + 'SOLO en la respuesta al dispatcher, igual que incident.',
            },
          },
        },
        IncidentSummary: {
          type: 'object',
          description: 'Incidente embebido en Emergency.incident (GET /api/emergencies).',
          properties: {
            id: { type: 'string', format: 'uuid' },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              example: 'critical',
            },
            score: { type: 'number', example: 87, nullable: true },
            reportCount: { type: 'integer', example: 3, description: 'Emergencias vinculadas a este incidente (todas, no solo activas)' },
            uniqueCitizens: { type: 'integer', example: 3 },
            reasonCodes: {
              type: 'array',
              items: { type: 'string' },
              example: ['MULTI_REPORT_THRESHOLD', 'PROXIMITY_CLUSTER'],
              nullable: true,
            },
          },
        },
        Incident: {
          type: 'object',
          description: 'Incidente listado en GET /api/incidents.',
          properties: {
            id: { type: 'string', format: 'uuid' },
            emergencyType: {
              type: 'string',
              enum: [...EMERGENCY_TYPES],
              nullable: true,
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              nullable: true,
            },
            score: { type: 'number', nullable: true },
            reasonCodes: { type: 'array', items: { type: 'string' }, nullable: true },
            factors: { type: 'object', nullable: true },
            algorithmVersion: { type: 'string', nullable: true, example: 'rule-based-v1' },
            emergencyCount: { type: 'integer', example: 3, description: 'Cantidad de emergencias vinculadas a este incidente' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        IncidentMember: {
          type: 'object',
          description: 'Emergencia miembro de un incidente, SIN coordenadas (GET /api/incidents/{id}).',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: [...EMERGENCY_STATUSES] },
            emergencyType: { type: 'string', enum: [...EMERGENCY_TYPES] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        IncidentDetail: {
          description: 'Incidente con sus emergencias miembro (GET /api/incidents/{id}).',
          allOf: [
            { $ref: '#/components/schemas/Incident' },
            {
              type: 'object',
              properties: {
                members: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/IncidentMember' },
                },
              },
            },
          ],
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer', example: 1 },
            limit: { type: 'integer', example: 20 },
            total: { type: 'integer', example: 42 },
            totalPages: { type: 'integer', example: 3 },
          },
        },
        StatusHistoryEntry: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            emergencyId: { type: 'string', format: 'uuid' },
            previousStatus: {
              type: 'string',
              enum: [...EMERGENCY_STATUSES],
              example: 'PENDING',
            },
            newStatus: {
              type: 'string',
              enum: [...EMERGENCY_STATUSES],
              example: 'VALIDATED',
            },
            actor: {
              type: 'string',
              nullable: true,
              example: 'D000007',
              description: 'Claim sub del JWT de quien hizo la transición',
            },
            reason: { type: 'string', nullable: true, example: 'Confirmado por operador' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        EmergencyDetail: {
          description: 'Emergencia con su historial de estados (GET /api/emergencies/{id}, tarea #32).',
          allOf: [
            { $ref: '#/components/schemas/Emergency' },
            {
              type: 'object',
              properties: {
                statusHistory: {
                  type: 'array',
                  description: 'Transiciones de estado en orden cronológico ascendente',
                  items: { $ref: '#/components/schemas/StatusHistoryEntry' },
                },
                observations: {
                  type: 'array',
                  description: 'Placeholder: siempre vacío hasta que exista el registro de observaciones.',
                  items: { type: 'object' },
                  example: [],
                },
                reinforcementRequests: {
                  type: 'array',
                  description: 'Placeholder: siempre vacío hasta que existan las solicitudes de refuerzo.',
                  items: { type: 'object' },
                  example: [],
                },
              },
            },
          ],
        },
        PanicButtonRequest: {
          type: 'object',
          required: ['location'],
          properties: {
            location: {
              allOf: [{ $ref: '#/components/schemas/Location' }],
              description: 'latitude debe estar en [-90, 90] y longitude en [-180, 180]; fuera de rango → 400.',
            },
            address: {
              type: 'string',
              maxLength: 200,
              example: 'Av. Corrientes 1234, CABA',
              description: 'Dirección legible opcional correspondiente a location, para que el '
                + 'dispatcher no dependa de geocodificación inversa en vivo. Se recorta a los '
                + 'extremos, se le quitan saltos de línea y se trunca a 200 caracteres. Si no '
                + 'viene, viene vacía, o no es un string, se ignora silenciosamente (nunca 400).',
            },
            description: {
              type: 'string',
              example: 'Necesito ayuda inmediata',
            },
            emergencyType: {
              type: 'string',
              // PREVENTIVA la crea solo el sistema (cobertura preventiva).
              enum: EMERGENCY_TYPES.filter((type) => type !== 'PREVENTIVA'),
              default: 'PANICO',
              example: 'INCENDIO',
              description: 'Tipo de emergencia. Si se omite, PANICO (botón SOS). '
                + 'Se aceptan también los alias en inglés en minúscula por compatibilidad '
                + '(panic, medical, fire, infrastructure, disturbance, other), que se normalizan al canónico.',
            },
            severity: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              deprecated: true,
              description: 'Ignorado. La severidad no la elige quien reporta: el backend la deriva '
                + 'de emergencyType (ver Emergency.severity). Un valor acá se loguea a nivel debug y no rompe con 400.',
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
