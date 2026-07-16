-- AGE-72: per-session comm account-label scoping via account_label_scope.

ALTER TABLE sessions ADD COLUMN account_label_scope TEXT;

DROP INDEX IF EXISTS idx_sessions_one_live_lease_per_agent_project;

-- Unlabeled sessions: at most one live lease per (agent, project).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_live_lease_unlabeled
  ON sessions(agent, project)
  WHERE lease_holder_connection_id IS NOT NULL
    AND status = 'active'
    AND account_label_scope IS NULL;

-- Labeled sessions: at most one live lease per (agent, project, scope).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_live_lease_labeled
  ON sessions(agent, project, account_label_scope)
  WHERE lease_holder_connection_id IS NOT NULL
    AND status = 'active'
    AND account_label_scope IS NOT NULL;
