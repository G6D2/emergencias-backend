-- Catálogo de oficiales para asignación por dispatcher (demo).
-- Los oficiales no se autentican en este módulo; solo se listan y asignan.

CREATE TABLE IF NOT EXISTS officers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    badge_number TEXT NOT NULL,
    location_label TEXT,
    distance_label TEXT,
    status TEXT NOT NULL DEFAULT 'disponible',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT officers_status_check CHECK (status IN ('disponible', 'ocupado'))
);

CREATE INDEX IF NOT EXISTS idx_officers_status ON officers (status);

INSERT INTO officers (id, name, badge_number, location_label, distance_label, status)
VALUES
    ('of-001', 'Oficial Carlos Gómez', 'CP-4021', 'Av. 9 de Julio y Corrientes', '350 m', 'disponible'),
    ('of-002', 'Oficial Mariana López', 'CP-3108', 'Plaza de Mayo', '800 m', 'disponible'),
    ('of-003', 'Oficial Martín Rodríguez', 'CP-5520', 'Av. Santa Fe y Callao', '1.2 km', 'disponible'),
    ('of-004', 'Oficial Lucía Fernández', 'CP-2214', 'Palermo Soho', '1.5 km', 'disponible'),
    ('of-005', 'Oficial Diego Álvarez', 'CP-7783', 'Recoleta', '2.1 km', 'disponible'),
    ('of-006', 'Oficial Sofía Ruiz', 'CP-1190', 'San Telmo', '900 m', 'disponible'),
    ('of-007', 'Oficial Pablo Méndez', 'CP-6402', 'Belgrano', '2.8 km', 'ocupado'),
    ('of-008', 'Oficial Valentina Castro', 'CP-3356', 'Caballito', '3.4 km', 'disponible'),
    ('of-009', 'Oficial Andrés Quiroga', 'CP-8811', 'Almagro', '1.8 km', 'disponible'),
    ('of-010', 'Oficial Camila Torres', 'CP-5044', 'Microcentro', '600 m', 'ocupado')
ON CONFLICT (id) DO NOTHING;
