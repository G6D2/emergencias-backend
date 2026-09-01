require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');

const emergencies = [
  ['10000000-0000-4000-8000-000000000001', 'ciudadano-001', -34.6037, -58.3816, 'Persona descompensada en la via publica', 'critical', 'PENDIENTE', 'oficial-101', 'MEDICA', '2026-08-28T09:00:00Z'],
  ['10000000-0000-4000-8000-000000000002', 'ciudadano-002', -34.6083, -58.3712, 'Robo en curso', 'critical', 'VALIDADA', 'oficial-102', 'SEGURIDAD', '2026-08-28T09:15:00Z'],
  ['10000000-0000-4000-8000-000000000003', 'ciudadano-003', -34.5997, -58.3921, 'Incendio menor en comercio', 'high', 'PENDIENTE', null, 'INCENDIO', '2026-08-28T10:00:00Z'],
  ['10000000-0000-4000-8000-000000000004', 'ciudadano-004', -34.6151, -58.3842, 'Accidente de transito sin heridos', 'medium', 'CANCELADA', null, 'TRANSITO', '2026-08-27T16:30:00Z'],
  ['10000000-0000-4000-8000-000000000005', 'ciudadano-005', -34.5924, -58.4051, 'Alarma vecinal activada por error', 'low', 'DESCARTADA', 'oficial-101', 'SEGURIDAD', '2026-08-26T14:45:00Z'],
  ['10000000-0000-4000-8000-000000000006', 'ciudadano-006', -34.6202, -58.3733, 'Asistencia medica finalizada', 'medium', 'CERRADA', 'oficial-103', 'MEDICA', '2026-08-25T11:20:00Z'],
];

async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está definida');
  }

  const pool = getPool();
  for (const emergency of emergencies) {
    await pool.query(
      `INSERT INTO emergencias (
        id, user_id, latitude, longitude, description, severity, status,
        assigned_officer_id, emergency_type, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        description = EXCLUDED.description,
        severity = EXCLUDED.severity,
        status = EXCLUDED.status,
        assigned_officer_id = EXCLUDED.assigned_officer_id,
        emergency_type = EXCLUDED.emergency_type,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      emergency
    );
  }

  console.log(`Se insertaron o actualizaron ${emergencies.length} emergencias de ejemplo.`);
}

seed()
  .catch((error) => {
    console.error('No se pudo ejecutar el seed:', error.message);
    process.exitCode = 1;
  })
  .finally(closePool);