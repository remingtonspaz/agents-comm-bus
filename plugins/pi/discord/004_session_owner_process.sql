ALTER TABLE sessions ADD COLUMN lease_owner_process_pid INTEGER;
ALTER TABLE sessions ADD COLUMN lease_owner_process_label TEXT;
ALTER TABLE sessions ADD COLUMN lease_owner_process_registered_at INTEGER;
