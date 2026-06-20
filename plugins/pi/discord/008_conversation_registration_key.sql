-- AGE-22: re-base conversation identity on the stable registration_id surrogate.
--
-- Drops the mutable account_label from conversations entirely (it is now
-- resolved on read from the owning registration, AGE-20 Phase 3b) and re-keys
-- the table on (registration_id, chat_native_id, thread_native_id).
-- conversation_id stays the opaque, stable UNIQUE row id / FK target.
-- registration_id becomes NOT NULL. project/agent/comm/bot_user_id are kept as
-- denormalized non-PK columns (no longer identity) for query convenience.
--
-- No history loss: rows that cannot be matched to a registration are preserved
-- with a deterministic orphan sentinel registration_id rather than deleted, so
-- their conversation_id, transcripts, queries and sessions remain intact.

PRAGMA foreign_keys = OFF;

-- 1. Backfill any still-null registration_id via the stable (comm, bot_user_id)
--    key (migration 005 populated bot_user_id; 006 did this once already).
UPDATE conversations
SET registration_id = (
  SELECT ar.registration_id
  FROM account_registrations ar
  WHERE ar.comm = conversations.comm
    AND ar.bot_user_id = conversations.bot_user_id
  LIMIT 1
)
WHERE registration_id IS NULL
  AND bot_user_id IS NOT NULL;

-- 2. Preserve any rows that are STILL null (no matching registration) with a
--    deterministic orphan sentinel so the NOT NULL surrogate PK holds without
--    deleting history. These rows have no registration to join, so their label
--    reads as empty/unregistered.
UPDATE conversations
SET registration_id = 'orphan_' || conversation_id
WHERE registration_id IS NULL;

-- 3. Rebuild without account_label and with the surrogate PK.
CREATE TABLE IF NOT EXISTS conversations_v2 (
  schema_version INTEGER NOT NULL,
  project TEXT NOT NULL,
  comm TEXT NOT NULL,
  bot_user_id TEXT,
  registration_id TEXT NOT NULL,
  chat_native_id TEXT NOT NULL,
  thread_native_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  last_message_id TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (registration_id, chat_native_id, thread_native_id),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

-- Plain INSERT (not OR IGNORE): the migration promise is "no history loss", so a
-- collision on the new (registration_id, chat, thread) PK or the conversation_id
-- unique key must FAIL LOUD, not silently skip a conversation — a skipped row
-- would (under foreign_keys = OFF) strand its queries/sessions/transcript refs on
-- a conversation_id that no longer exists. The backfill + orphan sentinel above
-- guarantee a non-null, collision-free key for well-formed source data.
INSERT INTO conversations_v2 (
  schema_version, project, comm, bot_user_id, registration_id, chat_native_id,
  thread_native_id, conversation_id, agent, last_inbound_at, last_outbound_at,
  last_message_id, created_at, metadata_json
)
SELECT
  schema_version, project, comm, bot_user_id, registration_id, chat_native_id,
  thread_native_id, conversation_id, agent, last_inbound_at, last_outbound_at,
  last_message_id, created_at, metadata_json
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_v2 RENAME TO conversations;

-- The surrogate PK already indexes (registration_id, chat_native_id,
-- thread_native_id); only the agent-scoped lookup index needs recreating.
CREATE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations(project, agent, comm);

PRAGMA foreign_keys = ON;
