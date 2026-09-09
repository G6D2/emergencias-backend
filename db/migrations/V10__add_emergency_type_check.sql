-- Tarea #44: catálogo cerrado de tipos de emergencia (español mayúsculas).
-- Espejo de src/domain/emergency-type.js. PANICO representa el botón SOS.

-- Las filas existentes tienen emergency_type NULL (el INSERT nunca lo escribió),
-- pero por si hubiera valores cargados a mano con los alias en inglés del
-- frontend, se normalizan antes de agregar el CHECK. Idempotente.
UPDATE emergencies
SET emergency_type = CASE lower(trim(emergency_type))
    WHEN 'panic' THEN 'PANICO'
    WHEN 'medical' THEN 'MEDICA'
    WHEN 'fire' THEN 'INCENDIO'
    WHEN 'infrastructure' THEN 'INFRAESTRUCTURA'
    WHEN 'disturbance' THEN 'DISTURBIO_EVENTO_MASIVO'
    WHEN 'other' THEN 'OTRO'
    ELSE upper(trim(emergency_type))
END
WHERE emergency_type IS NOT NULL
  AND emergency_type NOT IN (
    'MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO', 'OTRO', 'PANICO'
  );

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_emergency_type_check
    CHECK (
        emergency_type IS NULL
        OR emergency_type IN (
            'MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO', 'OTRO', 'PANICO'
        )
    );
