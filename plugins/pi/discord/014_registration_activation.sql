-- AGE-97: standing eager adapter activation for registrations with zero live sessions.
ALTER TABLE account_registrations
  ADD COLUMN activation TEXT NOT NULL DEFAULT 'lazy'
  CHECK (activation IN ('lazy', 'eager'));
