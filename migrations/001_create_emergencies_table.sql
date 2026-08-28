CREATE TABLE IF NOT EXISTS emergencies (
  id          UUID PRIMARY KEY,
  user_id     VARCHAR(255)  NOT NULL,
  lat         DECIMAL(10,8) NOT NULL,
  lng         DECIMAL(11,8) NOT NULL,
  description TEXT          NOT NULL DEFAULT 'Botón de pánico activado',
  severity    VARCHAR(50)   NOT NULL DEFAULT 'critical',
  status      VARCHAR(50)   NOT NULL DEFAULT 'creada',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
