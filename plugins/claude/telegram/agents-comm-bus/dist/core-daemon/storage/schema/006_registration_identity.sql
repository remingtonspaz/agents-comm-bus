-- AGE-20 Phase 1: additive registration_id (immutable surrogate identity).
--
-- Adds a stable, generated registration_id to account_registrations and threads
-- it onto conversations. NO behavior change in this phase: existing primary keys
-- and lookups are untouched; nothing yet reads registration_id as identity.
-- Phases 2-3 make registration_id canonical, stop deriving conversation_id from
-- mutable fields, and drop conversations.account_label.

ALTER TABLE account_registrations ADD COLUMN registration_id TEXT;

UPDATE account_registrations
SET registration_id = 'reg_' || lower(hex(randomblob(16)))
WHERE registration_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_registrations_registration_id
  ON account_registrations(registration_id);

ALTER TABLE conversations ADD COLUMN registration_id TEXT;

-- Backfill via the stable (comm, bot_user_id) key — bot_user_id was populated by
-- migration 005 — NOT the mutable account_label, so a relabel can't strand it.
UPDATE conversations
SET registration_id = (
  SELECT ar.registration_id
  FROM account_registrations ar
  WHERE ar.comm = conversations.comm
    AND ar.bot_user_id = conversations.bot_user_id
  LIMIT 1
)
WHERE registration_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_registration
  ON conversations(registration_id, chat_native_id, thread_native_id);
