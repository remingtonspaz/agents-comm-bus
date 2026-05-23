PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS allowlist_global (
  comm       TEXT    NOT NULL,
  sender_id  TEXT    NOT NULL,
  added_at   INTEGER NOT NULL,
  added_by   TEXT,
  note       TEXT,
  PRIMARY KEY (comm, sender_id)
);

CREATE TABLE IF NOT EXISTS allowlist_per_bot (
  comm         TEXT    NOT NULL,
  bot_user_id  TEXT    NOT NULL,
  sender_id    TEXT    NOT NULL,
  added_at     INTEGER NOT NULL,
  added_by     TEXT,
  note         TEXT,
  PRIMARY KEY (comm, bot_user_id, sender_id)
);

CREATE INDEX IF NOT EXISTS idx_allowlist_per_bot_by_bot
  ON allowlist_per_bot (comm, bot_user_id);

PRAGMA foreign_keys = ON;
