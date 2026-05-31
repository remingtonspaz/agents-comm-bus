-- AGE-20 Phase 3a: make registration_id the canonical primary key of
-- account_registrations. Table rebuild (same pattern as 002). All existing rows
-- already have a registration_id (backfilled by migration 006), so the NOT NULL
-- PK is satisfiable with no data loss.
--
-- We keep BOTH UNIQUE(comm, bot_user_id) (one bot per comm) AND
-- UNIQUE(project, comm, agent, account_label) (preserve the old "one per
-- project/agent/label" constraint that account-add + putAccountRegistration's
-- upsert rely on). Nothing foreign-keys account_registrations, so the rebuild is
-- safe.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS account_registrations_v2 (
  schema_version INTEGER NOT NULL,
  registration_id TEXT NOT NULL,
  project TEXT NOT NULL,
  comm TEXT NOT NULL,
  agent TEXT NOT NULL,
  account_label TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  credentials_ref TEXT NOT NULL,
  bot_username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (registration_id),
  UNIQUE (comm, bot_user_id),
  UNIQUE (project, comm, agent, account_label),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

INSERT OR IGNORE INTO account_registrations_v2 (
  schema_version, registration_id, project, comm, agent, account_label,
  bot_user_id, credentials_ref, bot_username, created_at, updated_at, metadata_json
)
SELECT
  schema_version, registration_id, project, comm, agent, account_label,
  bot_user_id, credentials_ref, bot_username, created_at, updated_at, metadata_json
FROM account_registrations;

DROP TABLE account_registrations;
ALTER TABLE account_registrations_v2 RENAME TO account_registrations;

PRAGMA foreign_keys = ON;
