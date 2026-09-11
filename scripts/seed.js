require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');

const officers = [
  ['of-001', 'Oficial Carlos Gómez', 'CP-4021', 'Av. 9 de Julio y Corrientes', '350 m', 'disponible'],
  ['of-002', 'Oficial Mariana López', 'CP-3108', 'Plaza de Mayo', '800 m', 'disponible'],
  ['of-003', 'Oficial Martín Rodríguez', 'CP-5520', 'Av. Santa Fe y Callao', '1.2 km', 'disponible'],
  ['of-004', 'Oficial Lucía Fernández', 'CP-2214', 'Palermo Soho', '1.5 km', 'disponible'],
  ['of-005', 'Oficial Diego Álvarez', 'CP-7783', 'Recoleta', '2.1 km', 'disponible'],
  ['of-006', 'Oficial Sofía Ruiz', 'CP-1190', 'San Telmo', '900 m', 'disponible'],
  ['of-007', 'Oficial Pablo Méndez', 'CP-6402', 'Belgrano', '2.8 km', 'ocupado'],
  ['of-008', 'Oficial Valentina Castro', 'CP-3356', 'Caballito', '3.4 km', 'disponible'],
  ['of-009', 'Oficial Andrés Quiroga', 'CP-8811', 'Almagro', '1.8 km', 'disponible'],
  ['of-010', 'Oficial Camila Torres', 'CP-5044', 'Microcentro', '600 m', 'ocupado'],
];

const emergencies = [
  ['10000000-0000-4000-8000-000000000001', 'ciudadano-001', -34.6037, -58.3816, 'Persona descompensada en la via publica', 'critical', 'PENDING', 'of-001', 'MEDICA', '2026-08-28T09:00:00Z'],
  ['10000000-0000-4000-8000-000000000002', 'ciudadano-002', -34.6083, -58.3712, 'Robo en curso', 'critical', 'VALIDATED', 'of-002', 'OTRO', '2026-08-28T09:15:00Z'],
  ['10000000-0000-4000-8000-000000000003', 'ciudadano-003', -34.5997, -58.3921, 'Incendio menor en comercio', 'high', 'PENDING', null, 'INCENDIO', '2026-08-28T10:00:00Z'],
  ['10000000-0000-4000-8000-000000000004', 'ciudadano-004', -34.6151, -58.3842, 'Accidente de transito sin heridos', 'medium', 'CANCELLED', null, 'OTRO', '2026-08-27T16:30:00Z'],
  ['10000000-0000-4000-8000-000000000005', 'ciudadano-005', -34.5924, -58.4051, 'Alarma vecinal activada por error', 'low', 'DISCARDED', 'of-001', 'OTRO', '2026-08-26T14:45:00Z'],
  ['10000000-0000-4000-8000-000000000006', 'ciudadano-006', -34.6202, -58.3733, 'Asistencia medica finalizada', 'medium', 'CLOSED', 'of-003', 'MEDICA', '2026-08-25T11:20:00Z'],
];

async function seed() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está definida');
  }

  const pool = getPool();

  for (const officer of officers) {
    await pool.query(
      `INSERT INTO officers (id, name, badge_number, location_label, distance_label, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         badge_number = EXCLUDED.badge_number,
         location_label = EXCLUDED.location_label,
         distance_label = EXCLUDED.distance_label,
         status = EXCLUDED.status,
         updated_at = now()`,
      officer
    );
  }

  for (const emergency of emergencies) {
    await pool.query(
      `INSERT INTO emergencies (
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

  console.log(`Se insertaron o actualizaron ${officers.length} oficiales y ${emergencies.length} emergencias de ejemplo.`);
}

seed()
  .catch((error) => {
    console.error('No se pudo ejecutar el seed:', error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
