ALTER TABLE conversations ADD COLUMN bot_user_id TEXT;

UPDATE conversations
SET bot_user_id = (
  SELECT account_registrations.bot_user_id
  FROM account_registrations
  WHERE account_registrations.project = conversations.project
    AND account_registrations.comm = conversations.comm
    AND account_registrations.agent = conversations.agent
    AND account_registrations.account_label = conversations.account_label
  LIMIT 1
)
WHERE bot_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_bot_identity
  ON conversations(project, agent, comm, bot_user_id, chat_native_id, thread_native_id);
