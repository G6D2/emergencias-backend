-- Usuarios locales (AUTH_MODE=local): registro/login email+password.
-- password_hash: bcrypt (no reversible).

CREATE TABLE IF NOT EXISTS auth_users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    groups TEXT[] NOT NULL DEFAULT ARRAY['citizen']::TEXT[],
    has_antipanic_button BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT auth_users_email_nonempty CHECK (length(trim(email)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email_lower
    ON auth_users (lower(email));

-- Cuentas demo (password: abracadabra) para la presentación.
INSERT INTO auth_users (id, email, password_hash, display_name, groups, has_antipanic_button)
VALUES
    (
      'a1111111-1111-4111-8111-111111111111',
      'juanpanico@gmail.com',
      '$2b$10$qYXv1UCFbQTXEgdu90xfsesVZu50Y51Qq14l9U1QBCRnz0T6a7Z7m',
      'JuanPanico',
      ARRAY['citizen']::TEXT[],
      true
    ),
    (
      'a2222222-2222-4222-8222-222222222222',
      'luciatranquila@gmail.com',
      '$2b$10$qYXv1UCFbQTXEgdu90xfsesVZu50Y51Qq14l9U1QBCRnz0T6a7Z7m',
      'LuciaTranquila',
      ARRAY['citizen']::TEXT[],
      false
    )
ON CONFLICT (id) DO NOTHING;
