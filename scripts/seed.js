/**
 * seed.js — seed completo para demo/desarrollo de CityPass+
 *
 * Limpia las tablas de datos y carga:
 *   - 10 oficiales (8 disponibles, 2 ocupados)
 *   - 24 emergencias cubriendo todos los tipos, criticidades, estados y ubicaciones
 *
 * Uso:
 *   npm run seed
 *   node scripts/seed.js
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');

// ─────────────────────────────────────────────────────────────────────────────
// OFICIALES
// [id, name, badge_number, location_label, distance_label, status]
// ─────────────────────────────────────────────────────────────────────────────
const officers = [
  ['of-001', 'Tte. Santino Joaquín',   'CP-4021', 'Av. 9 de Julio y Corrientes',   '350 m',  'disponible'],
  ['of-002', 'Sgt. Mariana López',     'CP-3108', 'Plaza de Mayo',                  '800 m',  'disponible'],
  ['of-003', 'Cabo Martín Rodríguez',  'CP-5520', 'Av. Santa Fe y Callao',          '1.2 km', 'disponible'],
  ['of-004', 'Sgt. Lucía Fernández',   'CP-2214', 'Palermo Soho',                   '1.5 km', 'disponible'],
  ['of-005', 'Tte. Diego Álvarez',     'CP-7783', 'Recoleta, Av. del Libertador',   '2.1 km', 'disponible'],
  ['of-006', 'Sgt. Sofía Ruiz',        'CP-1190', 'San Telmo, Defensa 700',         '900 m',  'disponible'],
  ['of-007', 'Cabo Pablo Méndez',      'CP-6402', 'Belgrano, Cabildo y Juramento',  '2.8 km', 'ocupado'],
  ['of-008', 'Sgt. Valentina Castro',  'CP-3356', 'Caballito, Rivadavia 5400',      '3.4 km', 'disponible'],
  ['of-009', 'Tte. Andrés Quiroga',    'CP-8811', 'Almagro, Corrientes 3800',       '1.8 km', 'disponible'],
  ['of-010', 'Cabo Camila Torres',     'CP-5044', 'Microcentro, Florida y Lavalle', '600 m',  'ocupado'],
];

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCIAS
// Tipos válidos: MEDICA · INCENDIO · INFRAESTRUCTURA · DISTURBIO_EVENTO_MASIVO · OTRO · PANICO
// Severity:      critical · high · medium · low
// Estados:       PENDING · VALIDATED · DISPATCHED · EN_ROUTE · ON_SITE · CLOSED · CANCELLED · DISCARDED
//
// Usamos lat/lng en claro (location_encrypted = NULL); la retención los
// anonimizará después de 72 h según la política LOCATION_RETENTION_HOURS.
// ─────────────────────────────────────────────────────────────────────────────
const emergencies = [
  // ── MEDICA ────────────────────────────────────────────────────────────────
  {
    id: 'a0000001-0000-4000-8000-000000000001', userId: 'CIT-Demo-Maria',
    lat: -34.6037, lng: -58.3816,
    desc: 'Persona desmayada en la vía pública frente al Obelisco',
    severity: 'critical', status: 'PENDING',    officerId: null,    type: 'MEDICA',
    createdAt: '2026-09-24T08:00:00Z', closedAt: null,
  },
  {
    id: 'a0000002-0000-4000-8000-000000000002', userId: 'CIT-Demo-Pedro',
    lat: -34.5999, lng: -58.3731,
    desc: 'Ataque cardíaco en oficina del Microcentro, piso 4',
    severity: 'high',     status: 'VALIDATED',  officerId: null,    type: 'MEDICA',
    createdAt: '2026-09-24T09:15:00Z', closedAt: null,
  },
  {
    id: 'a0000003-0000-4000-8000-000000000003', userId: 'CIT-Demo-Lucia',
    lat: -34.5878, lng: -58.4021,
    desc: 'Persona mayor caída en escaleras del subte Palermo',
    severity: 'medium',   status: 'DISPATCHED', officerId: 'of-001', type: 'MEDICA',
    createdAt: '2026-09-24T10:30:00Z', closedAt: null,
  },
  {
    id: 'a0000004-0000-4000-8000-000000000004', userId: 'CIT-Demo-Ana',
    lat: -34.6150, lng: -58.4280,
    desc: 'Reacción alérgica grave en parque Caballito',
    severity: 'low',      status: 'CLOSED',     officerId: 'of-003', type: 'MEDICA',
    createdAt: '2026-09-23T14:00:00Z', closedAt: '2026-09-23T14:55:00Z',
  },

  // ── INCENDIO ──────────────────────────────────────────────────────────────
  {
    id: 'a0000005-0000-4000-8000-000000000005', userId: 'CIT-Demo-Roberto',
    lat: -34.6083, lng: -58.3712,
    desc: 'Incendio declarado en depósito de materiales, San Telmo',
    severity: 'critical', status: 'EN_ROUTE',   officerId: 'of-006', type: 'INCENDIO',
    createdAt: '2026-09-24T07:45:00Z', closedAt: null,
  },
  {
    id: 'a0000006-0000-4000-8000-000000000006', userId: 'CIT-Demo-Silvia',
    lat: -34.5800, lng: -58.4550,
    desc: 'Columna de humo visible desde Villa del Parque, posible cortocircuito',
    severity: 'high',     status: 'ON_SITE',    officerId: 'of-009', type: 'INCENDIO',
    createdAt: '2026-09-24T11:00:00Z', closedAt: null,
  },
  {
    id: 'a0000007-0000-4000-8000-000000000007', userId: 'CIT-Demo-Jorge',
    lat: -34.6202, lng: -58.3410,
    desc: 'Incendio menor en balcón de edificio, Barracas',
    severity: 'medium',   status: 'DISCARDED',  officerId: null,    type: 'INCENDIO',
    createdAt: '2026-09-23T16:00:00Z', closedAt: null,
  },
  {
    id: 'a0000008-0000-4000-8000-000000000008', userId: 'CIT-Demo-Carla',
    lat: -34.5660, lng: -58.4380,
    desc: 'Quema de residuos en terreno baldío, Villa Urquiza',
    severity: 'low',      status: 'CLOSED',     officerId: 'of-002', type: 'INCENDIO',
    createdAt: '2026-09-23T11:30:00Z', closedAt: '2026-09-23T12:15:00Z',
  },

  // ── INFRAESTRUCTURA ───────────────────────────────────────────────────────
  {
    id: 'a0000009-0000-4000-8000-000000000009', userId: 'CIT-Demo-Miguel',
    lat: -34.6115, lng: -58.3960,
    desc: 'Socavón profundo en calzada, Almagro — vía cortada',
    severity: 'critical', status: 'PENDING',    officerId: null,    type: 'INFRAESTRUCTURA',
    createdAt: '2026-09-24T06:30:00Z', closedAt: null,
  },
  {
    id: 'a0000010-0000-4000-8000-000000000010', userId: 'CIT-Demo-Gabriela',
    lat: -34.5924, lng: -58.4051,
    desc: 'Luminaria en riesgo de caída sobre acera, Palermo',
    severity: 'high',     status: 'VALIDATED',  officerId: null,    type: 'INFRAESTRUCTURA',
    createdAt: '2026-09-24T12:00:00Z', closedAt: null,
  },
  {
    id: 'a0000011-0000-4000-8000-000000000011', userId: 'CIT-Demo-Tomas',
    lat: -34.6295, lng: -58.3620,
    desc: 'Semáforo fuera de servicio en intersección de alto tránsito, La Boca',
    severity: 'medium',   status: 'DISPATCHED', officerId: 'of-004', type: 'INFRAESTRUCTURA',
    createdAt: '2026-09-24T08:45:00Z', closedAt: null,
  },
  {
    id: 'a0000012-0000-4000-8000-000000000012', userId: 'CIT-Demo-Fernanda',
    lat: -34.5750, lng: -58.4900,
    desc: 'Pérdida de gas en cañería pública, Agronomía',
    severity: 'low',      status: 'CLOSED',     officerId: 'of-008', type: 'INFRAESTRUCTURA',
    createdAt: '2026-09-23T09:00:00Z', closedAt: '2026-09-23T10:30:00Z',
  },

  // ── DISTURBIO_EVENTO_MASIVO ───────────────────────────────────────────────
  {
    id: 'a0000013-0000-4000-8000-000000000013', userId: 'CIT-Demo-Esteban',
    lat: -34.6037, lng: -58.4135,
    desc: 'Pelea masiva en recital al aire libre, estadio Obras',
    severity: 'critical', status: 'ON_SITE',    officerId: 'of-007', type: 'DISTURBIO_EVENTO_MASIVO',
    createdAt: '2026-09-24T19:45:00Z', closedAt: null,
  },
  {
    id: 'a0000014-0000-4000-8000-000000000014', userId: 'CIT-Demo-Valeria',
    lat: -34.6180, lng: -58.3682,
    desc: 'Manifestación con corte de tránsito sobre autopista 25 de Mayo',
    severity: 'high',     status: 'PENDING',    officerId: null,    type: 'DISTURBIO_EVENTO_MASIVO',
    createdAt: '2026-09-24T13:00:00Z', closedAt: null,
  },
  {
    id: 'a0000015-0000-4000-8000-000000000015', userId: 'CIT-Demo-Santiago',
    lat: -34.5970, lng: -58.4300,
    desc: 'Disturbio en fiesta clandestina, Villa Crespo',
    severity: 'medium',   status: 'CANCELLED',  officerId: null,    type: 'DISTURBIO_EVENTO_MASIVO',
    createdAt: '2026-09-23T03:30:00Z', closedAt: null,
  },
  {
    id: 'a0000016-0000-4000-8000-000000000016', userId: 'CIT-Demo-Paula',
    lat: -34.5630, lng: -58.4600,
    desc: 'Altercado verbal en mercado de pulgas, Colegiales',
    severity: 'low',      status: 'CLOSED',     officerId: 'of-005', type: 'DISTURBIO_EVENTO_MASIVO',
    createdAt: '2026-09-23T17:00:00Z', closedAt: '2026-09-23T17:45:00Z',
  },

  // ── OTRO ──────────────────────────────────────────────────────────────────
  {
    id: 'a0000017-0000-4000-8000-000000000017', userId: 'CIT-Demo-Laura',
    lat: -34.6390, lng: -58.3740,
    desc: 'Persona en situación de calle requiere asistencia urgente, Constitución',
    severity: 'critical', status: 'EN_ROUTE',   officerId: 'of-010', type: 'OTRO',
    createdAt: '2026-09-24T07:00:00Z', closedAt: null,
  },
  {
    id: 'a0000018-0000-4000-8000-000000000018', userId: 'CIT-Demo-Nicolas',
    lat: -34.6050, lng: -58.4450,
    desc: 'Animal herido en plena calzada bloqueando carril, Flores',
    severity: 'high',     status: 'VALIDATED',  officerId: null,    type: 'OTRO',
    createdAt: '2026-09-24T10:00:00Z', closedAt: null,
  },
  {
    id: 'a0000019-0000-4000-8000-000000000019', userId: 'CIT-Demo-Florencia',
    lat: -34.5830, lng: -58.3850,
    desc: 'Vehículo abandonado obstruye entrada de emergencia, Recoleta',
    severity: 'medium',   status: 'CLOSED',     officerId: 'of-002', type: 'OTRO',
    createdAt: '2026-09-23T13:00:00Z', closedAt: '2026-09-23T14:00:00Z',
  },
  {
    id: 'a0000020-0000-4000-8000-000000000020', userId: 'CIT-Demo-Ignacio',
    lat: -34.6480, lng: -58.4150,
    desc: 'Ruidos molestos persistentes en domicilio, Nueva Pompeya',
    severity: 'low',      status: 'DISCARDED',  officerId: null,    type: 'OTRO',
    createdAt: '2026-09-23T22:00:00Z', closedAt: null,
  },

  // ── PANICO (botón SOS) ────────────────────────────────────────────────────
  {
    id: 'a0000021-0000-4000-8000-000000000021', userId: 'CIT-Demo-Julian',
    lat: -34.6155, lng: -58.4010,
    desc: 'Botón de pánico activado',
    severity: 'critical', status: 'PENDING',    officerId: null,    type: 'PANICO',
    createdAt: '2026-09-24T14:00:00Z', closedAt: null,
  },
  {
    id: 'a0000022-0000-4000-8000-000000000022', userId: 'CIT-Demo-Camila',
    lat: -34.6020, lng: -58.3550,
    desc: 'Botón de pánico activado',
    severity: 'high',     status: 'DISPATCHED', officerId: 'of-005', type: 'PANICO',
    createdAt: '2026-09-24T09:50:00Z', closedAt: null,
  },
  {
    id: 'a0000023-0000-4000-8000-000000000023', userId: 'CIT-Demo-Matias',
    lat: -34.5700, lng: -58.4200,
    desc: 'Botón de pánico activado',
    severity: 'medium',   status: 'CLOSED',     officerId: 'of-004', type: 'PANICO',
    createdAt: '2026-09-23T20:00:00Z', closedAt: '2026-09-23T20:30:00Z',
  },
  {
    id: 'a0000024-0000-4000-8000-000000000024', userId: 'CIT-Demo-Rocio',
    lat: -34.6310, lng: -58.4520,
    desc: 'Botón de pánico activado',
    severity: 'low',      status: 'CANCELLED',  officerId: null,    type: 'PANICO',
    createdAt: '2026-09-23T18:00:00Z', closedAt: null,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está definida');
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Limpiar datos en orden por FK
    console.log('🧹  Limpiando tablas...');
    await client.query('DELETE FROM emergency_access_audit');
    await client.query('DELETE FROM emergency_status_history');
    await client.query('DELETE FROM outbox_events');
    await client.query('ALTER TABLE emergencies DISABLE TRIGGER ALL');
    await client.query('DELETE FROM emergencies');
    await client.query('ALTER TABLE emergencies ENABLE TRIGGER ALL');
    await client.query('DELETE FROM incidents');
    await client.query('DELETE FROM officers');
    console.log('   ✓ Tablas limpias');

    // 2. Insertar oficiales
    console.log(`\n👮  Insertando ${officers.length} oficiales...`);
    for (const [id, name, badge, locLabel, distLabel, status] of officers) {
      await client.query(
        `INSERT INTO officers (id, name, badge_number, location_label, distance_label, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, name, badge, locLabel, distLabel, status]
      );
    }
    console.log(`   ✓ ${officers.length} oficiales insertados`);

    // 3. Insertar emergencias
    console.log(`\n🚨  Insertando ${emergencies.length} emergencias de demo...`);
    for (const e of emergencies) {
      await client.query(
        `INSERT INTO emergencies (
           id, user_id, latitude, longitude, location_encrypted,
           description, severity, status,
           assigned_officer_id, emergency_type,
           correlation_id, created_at, updated_at, closed_at
         ) VALUES (
           $1, $2, $3, $4, NULL,
           $5, $6, $7,
           $8, $9,
           $1, $10, $10, $11
         )`,
        [
          e.id, e.userId, e.lat, e.lng,
          e.desc, e.severity, e.status,
          e.officerId, e.type,
          e.createdAt, e.closedAt,
        ]
      );
    }
    console.log(`   ✓ ${emergencies.length} emergencias insertadas`);

    await client.query('COMMIT');

    // Resumen
    const byType = {};
    const byStatus = {};
    const bySeverity = {};
    for (const e of emergencies) {
      byType[e.type]         = (byType[e.type]         || 0) + 1;
      byStatus[e.status]     = (byStatus[e.status]     || 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    }
    console.log('\n📊  Resumen del seed:');
    console.log('   Tipos:       ', JSON.stringify(byType));
    console.log('   Estados:     ', JSON.stringify(byStatus));
    console.log('   Criticidades:', JSON.stringify(bySeverity));
    console.log('\n✅  Seed completado exitosamente.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .catch((error) => {
    console.error('\n❌  No se pudo ejecutar el seed:', error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
