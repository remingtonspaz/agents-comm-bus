ALTER TABLE sessions ADD COLUMN lease_owner_daemon_discovery_root TEXT;
ALTER TABLE sessions ADD COLUMN lease_owner_daemon_checkout_root TEXT;
ALTER TABLE sessions ADD COLUMN lease_owner_daemon_state_root TEXT;
ALTER TABLE sessions ADD COLUMN lease_owner_daemon_bin TEXT;
ALTER TABLE sessions ADD COLUMN lease_owner_daemon_authority_rank TEXT;
