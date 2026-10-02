-- AGE-110: herdr pane wake identity + wake mode preferences.
ALTER TABLE sessions ADD COLUMN wake_identity_json TEXT;
ALTER TABLE sessions ADD COLUMN wake_strict TEXT;

CREATE TABLE wake_preferences (
  project TEXT NOT NULL DEFAULT '',
  agent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('auto', 'native')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(project, agent)
);
