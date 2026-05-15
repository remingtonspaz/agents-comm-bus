PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS account_registrations (
  schema_version INTEGER NOT NULL,
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
  PRIMARY KEY (project, comm, agent, account_label),
  UNIQUE (comm, bot_user_id),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE TABLE IF NOT EXISTS conversations (
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
  PRIMARY KEY (project, comm, account_label, chat_native_id, thread_native_id),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations(project, agent, comm);

CREATE TABLE IF NOT EXISTS sessions (
  schema_version INTEGER NOT NULL,
  session_id TEXT NOT NULL PRIMARY KEY,
  agent TEXT NOT NULL,
  project TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lease_holder_connection_id TEXT,
  lease_acquired_at INTEGER,
  lease_released_at INTEGER,
  most_recent_inbound_conversation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  FOREIGN KEY (most_recent_inbound_conversation_id)
    REFERENCES conversations(conversation_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_project
  ON sessions(agent, project, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_live_lease_per_agent_project
  ON sessions(agent, project)
  WHERE lease_holder_connection_id IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS queries (
  schema_version INTEGER NOT NULL,
  query_id TEXT NOT NULL PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'choice', 'freetext')),
  prompt_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  origin_chat_id TEXT,
  source_message_id TEXT,
  resolved_at INTEGER,
  resolution_json TEXT,
  options_json TEXT,
  FOREIGN KEY (session_id)
    REFERENCES sessions(session_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  FOREIGN KEY (origin_chat_id)
    REFERENCES conversations(conversation_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  CHECK ((resolved_at IS NULL AND resolution_json IS NULL) OR (resolved_at IS NOT NULL AND resolution_json IS NOT NULL)),
  CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  CHECK (options_json IS NULL OR json_valid(options_json))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_queries_one_open_per_session
  ON queries(session_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_queries_session_created
  ON queries(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_queries_origin_open
  ON queries(origin_chat_id, created_at)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  metadata_json TEXT,
  PRIMARY KEY (scope, key),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE TABLE IF NOT EXISTS transcript_refs (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  transcript_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversations(conversation_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blob_refs (
  blob_hash TEXT NOT NULL PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_blobs (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id, ordinal),
  FOREIGN KEY (conversation_id)
    REFERENCES conversations(conversation_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  FOREIGN KEY (blob_hash)
    REFERENCES blob_refs(blob_hash)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);
