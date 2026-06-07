PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS conversations_v2 (
  schema_version INTEGER NOT NULL,
  project TEXT NOT NULL,
  comm TEXT NOT NULL,
  account_label TEXT NOT NULL,
  chat_native_id TEXT NOT NULL,
  thread_native_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  last_message_id TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (project, agent, comm, account_label, chat_native_id, thread_native_id),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

INSERT OR IGNORE INTO conversations_v2 (
  schema_version, project, comm, account_label, chat_native_id,
  thread_native_id, conversation_id, agent, last_inbound_at,
  last_outbound_at, last_message_id, created_at, metadata_json
)
SELECT
  schema_version, project, comm, account_label, chat_native_id,
  thread_native_id, conversation_id, agent, last_inbound_at,
  last_outbound_at, last_message_id, created_at, metadata_json
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_v2 RENAME TO conversations;

CREATE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations(project, agent, comm);

PRAGMA foreign_keys = ON;
