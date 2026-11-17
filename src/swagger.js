const swaggerJsdoc = require('swagger-jsdoc');
const { EMERGENCY_STATUSES } = require('./domain/emergency-status');
const { EMERGENCY_TYPES } = require('./domain/emergency-type');

// Mismo vocabulario que el CHECK de outbox_events (V6, V8 y V21).
const OUTBOX_STATUSES = ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'SKIPPED'];

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Emergencias Backend API',
      version: '0.1.0',
      description:
        'API del módulo de Emergencias y Seguridad (CityPass+). Botón de pánico, ciclo de vida de '
        + 'emergencias, incidentes y perfil ciudadano. Autenticación con JWT del contrato CityPass+ '
        + '(AUTH_MODE=local: emitido por el propio backend; AUTH_MODE=hybrid: además acepta el del '
        + 'Login Federado del Grupo 2).',
    },
    // Relativo: "Try it out" pega contra el mismo host que sirve /api-docs
    // (localhost, Render o el backup), sin URL fija.
    servers: [
      {
        url: '/',
        description: 'Mismo host que sirve esta documentación',
      },
    ],
    tags: [
      { name: 'Health', description: 'Estado del servicio' },
      { name: 'User', description: 'Perfil del usuario autenticado' },
      { name: 'Dev Auth', description: 'Registro, login y dev login locales (AUTH_MODE=local o hybrid)' },
      { name: 'Panic Button', description: 'Activación y consulta de botón de pánico' },
      { name: 'Emergencies', description: 'Listado, detalle y cambios de estado de emergencias' },
      { name: 'Officers', description: 'Catálogo de oficiales para asignación (dispatcher)' },
      { name: 'Incidents', description: 'Resultado del motor de detección de incidentes (dispatcher)' },
      { name: 'CitizenProfile', description: 'Perfil personal y ubicaciones frecuentes del ciudadano' },
      { name: 'Outbox', description: 'Estado operativo de los eventos pendientes de publicar (dispatcher)' },
      { name: 'ContextosZona', description: 'Alertas climáticas activas para el banner del tablero (dispatcher)' },
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
              description: 'Igual al id en las altas ciudadanas (ADR-001). En las externas conserva el id de '
                + 'correlación del otro módulo aunque no sea UUID (p. ej. EMG-... de Movilidad, V32). '
                + 'Traza creación → priorización → despacho en los eventos.',
            },
            userId: {
              type: 'string',
              nullable: true,
              example: 'U000042',
              description: 'Claim sub del JWT de quien reportó. null en las emergencias EXTERNAL '
                + '(no tienen ciudadano, p. ej. la cobertura preventiva).',
            },
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
            descripcionProblema: {
              type: 'string',
              nullable: true,
              maxLength: 280,
              example: 'Bache profundo en la calzada junto a la esquina.',
              description: 'Descripción breve requerida al resolver con causa VIA; null en los demás casos.',
            },
            assignedOfficerId: {
              type: 'string',
              nullable: true,
              example: null,
              description: 'Id del oficial asignado (catálogo de /api/officers). null hasta el despacho. '
                + 'Al devolver (return), cancelar o cerrar, el oficial vuelve a disponible pero el id queda en la fila.',
            },
            assignedOfficer: {
              type: 'string',
              nullable: true,
              example: 'Oficial Carlos Gómez',
              description: 'Nombre del oficial asignado (JOIN con officers). Viene en el listado, el detalle '
                + 'y la respuesta de assign; en las respuestas de los demás cambios de estado viene null.',
            },
            incidentId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Id del incidente al que la agrupó el motor de detección, o null. Viene en todas '
                + 'las respuestas, también al citizen: el listado le recorta incident, pero no este id.',
            },
            source: {
              type: 'string',
              enum: ['INTERNAL', 'EXTERNAL'],
              example: 'INTERNAL',
              description: 'INTERNAL: reportada por un ciudadano. EXTERNAL: creada por un listener de '
                + 'eventos de otro módulo (cobertura preventiva y alerta climática de Espacios, intervención '
                + 'por reclamo de ciclovía, emergencia en bicicleta de Movilidad).',
            },
            requiresManualValidation: {
              type: 'boolean',
              example: false,
              description: 'true si la emergencia externa llegó sin ubicación y el dispatcher tiene que revisarla.',
            },
            causaTipo: {
              type: 'string',
              nullable: true,
              enum: ['EVENTO_CLIMATICO', 'RECLAMO', 'INCIDENTE_VIAL', 'EVENTO_PUBLICO', 'RESERVA', 'MOVILIDAD_BICICLETA', null],
              example: null,
              description: 'Qué originó la emergencia (CHECK de V23 y V32). null en las reportadas por un ciudadano. '
                + 'Lo completan los listeners: EVENTO_PUBLICO y RESERVA (cobertura preventiva), EVENTO_CLIMATICO '
                + '(alerta climática), RECLAMO (intervención por reclamo de ciclovía) y MOVILIDAD_BICICLETA. '
                + 'INCIDENTE_VIAL todavía no lo usa ningún listener.',
            },
            causaId: {
              type: 'string',
              nullable: true,
              example: null,
              description: 'Id de la causa en el módulo de origen (p. ej. eventoId de Espacios). '
                + 'Va junto con causaTipo: los dos o ninguno.',
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
                + 'Solo viene en el listado y el detalle. Lo reciben el dispatcher y el officer (en su '
                + 'listado, que es lo único que ve); al citizen se lo recortan el listado y el detalle '
                + '(GET /api/emergencies/{id} y GET /api/panic-button/{id}).',
            },
            effectivePriority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              example: 'critical',
              description: 'Máximo entre severity y incident.priority (nunca menor a severity). '
                + 'Misma visibilidad que incident.',
            },
            dispatchPriority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              example: 'critical',
              description: 'Prioridad de despacho: effectivePriority más un nivel (tope critical) si '
                + 'la emergencia se creó dentro del radio de un contexto de zona que sigue en curso, por '
                + 'ejemplo un evento en un espacio público. Se calcula al leer: cuando el contexto vence o se da '
                + 'de baja vuelve a ser igual a effectivePriority. No sube en emergencias PREVENTIVA ni '
                + 'en estados terminales. sortBy=priority ordena por este valor. Para el dispatcher y el '
                + 'officer (en su listado); el citizen no lo recibe.',
            },
            priorityContext: {
              type: 'object',
              nullable: true,
              description: 'Contexto de zona que eleva dispatchPriority, o null si no hay ninguno '
                + 'vigente. Para el dispatcher y el officer (en su listado); el citizen no lo recibe.',
              properties: {
                tipo: { type: 'string', enum: ['EVENTO_ESPACIO_PUBLICO', 'ALERTA_CLIMATICA'] },
                latitud: { type: 'number', example: -34.5711, description: 'Punto del contexto (ubicación del evento).' },
                longitud: { type: 'number', example: -58.4167 },
                radioMetros: { type: 'integer', example: 500, description: 'Radio de la zona alrededor del punto.' },
                origen: { type: 'string', example: 'espacios' },
                referenciaExterna: { type: 'string', description: 'Id del objeto en el módulo de origen (eventoId).' },
                descripcion: { type: 'string', nullable: true, example: 'Recital en el Rosedal' },
                vigenteDesde: { type: 'string', format: 'date-time' },
                vigenteHasta: { type: 'string', format: 'date-time' },
              },
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
                hasAntipanicButton: { type: 'boolean' },
                authSource: {
                  type: 'string',
                  enum: ['local', 'federated'],
                  description: 'Solo AUTH_MODE=hybrid: quién emitió el token',
                },
                idpSub: {
                  type: 'string',
                  description: 'Solo tokens del Login Federado: sub original (antes de IDP_SUB_ALIASES)',
                  example: 'U000123',
                },
                idpGroups: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Solo tokens del Login Federado: grupos tal como vienen en el token, '
                    + 'antes de IDP_GROUP_MAP',
                  example: ['dispatchers'],
                },
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
        AlertaClimaticaActiva: {
          type: 'object',
          description: 'Una alerta climática de Espacios con contextos de zona activos o por empezar '
            + '(GET /api/contextos-zona/activos). Una entrada por alerta, no por punto.',
          properties: {
            alertaId: { type: 'string', example: 'a7f0e2c4-1b3d-4e5f-8a9b-0c1d2e3f4a5b', description: 'alertaId de Espacios.' },
            nivel: {
              type: 'string',
              nullable: true,
              enum: ['ALTA', 'CRITICA'],
              description: 'Nivel de la alerta. Solo ALTA y CRITICA generan contextos (MEDIA y BAJA no aparecen).',
            },
            fenomeno: { type: 'string', nullable: true, example: 'TORMENTA_FUERTE', description: 'Código del catálogo de Espacios.' },
            fenomenoEtiqueta: { type: 'string', nullable: true, example: 'Tormenta fuerte' },
            barrios: {
              type: 'array',
              items: { type: 'string' },
              example: ['SAN NICOLAS', 'BELGRANO'],
              description: 'Barrios que informa la alerta, tal como llegan. Solo para mostrar: la zona es punto + radio.',
            },
            vigenteDesde: { type: 'string', format: 'date-time' },
            vigenteHasta: { type: 'string', format: 'date-time' },
            enCurso: {
              type: 'boolean',
              description: 'true si la alerta ya empezó: las emergencias que se crean dentro del radio de '
                + 'algún punto suben un nivel. false si todavía no empezó (vigenteDesde en el futuro).',
            },
            puntos: { type: 'integer', example: 2, description: 'Cantidad de puntos (contextos) de la alerta.' },
            radioMetros: { type: 'integer', example: 500, description: 'Radio alrededor de cada punto (CRITICA 1000, ALTA 500).' },
            descripcion: { type: 'string', nullable: true, example: 'Alerta climática ALTA: tormenta fuerte' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              example: 'NotFoundError',
              description: 'Código del error, para máquinas: no cambia. Para distinguir casos, '
                + 'comparar el status HTTP y este campo, no el texto de message.',
            },
            message: {
              type: 'string',
              example: 'No se encontró la emergencia 8e03978e-40d5-43e8-bc93-6894a57f9324',
              description: 'Texto para mostrar, en castellano. Puede cambiar.',
            },
          },
        },
        OutboxStatus: {
          type: 'string',
          enum: OUTBOX_STATUSES,
          description: 'PENDING: espera publicación. PROCESSING: reclamado por el publisher. '
            + 'PUBLISHED: Kafka confirmó el envío. FAILED: error propio del evento (400/403/404/413 del gateway); '
            + 'frena a los posteriores de su emergencia hasta reencolarlo o descartarlo (npm run outbox:requeue-failed). '
            + 'SKIPPED: PENDING anterior a OUTBOX_PUBLISH_SINCE, descartado al arrancar el publisher (V21).',
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
            kafka: {
              type: 'string',
              enum: ['connected', 'disconnected', 'disabled'],
              example: 'connected',
              description: 'disabled con KAFKA_ENABLED=false. connected si el producer (cuando el outbox publica) '
                + 'y cada listener con topic están arriba. Sale del estado en memoria del proceso, sin conectarse al broker.',
            },
            outbox: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean', example: false },
                producerConnected: { type: 'boolean', example: false },
                lastPollAt: { type: 'string', format: 'date-time', nullable: true },
                pausedUntil: {
                  type: 'string',
                  format: 'date-time',
                  nullable: true,
                  description: 'Hasta cuándo no publica porque el bus no respondió (issue #104). null si anda.',
                },
                consecutiveFailures: {
                  type: 'integer',
                  example: 0,
                  description: 'Errores transitorios seguidos del bus; vuelve a 0 con el primer envío que sale bien.',
                },
              },
            },
            listeners: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'EventoCanceladoListener' },
                  running: { type: 'boolean', example: true },
                  status: {
                    type: 'string',
                    enum: ['starting', 'running', 'retrying', 'disabled', 'stopped'],
                    example: 'running',
                  },
                  lastPollAt: { type: 'string', format: 'date-time', nullable: true },
                  nextRetryAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
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

// El filtro `status` de GET /api/outbox-events trae su propio enum en el
// JSDoc de la ruta; se apunta al schema OutboxStatus para que la doc liste
// los mismos estados que acepta la base (incluido SKIPPED).
function useOutboxStatusSchema(spec) {
  const parameters = spec.paths?.['/api/outbox-events']?.get?.parameters || [];
  for (const parameter of parameters) {
    if (parameter.in === 'query' && parameter.name === 'status') {
      parameter.schema = { $ref: '#/components/schemas/OutboxStatus' };
    }
  }
  return spec;
}

const swaggerSpec = useOutboxStatusSchema(swaggerJsdoc(options));

module.exports = { swaggerSpec };
