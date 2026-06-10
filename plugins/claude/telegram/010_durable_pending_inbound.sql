-- AGE-56: durable pending inbound deliveries survive daemon restarts and
-- in-memory queue overflow. Rows are written when dispatch enqueues a message
-- and deleted when an agent drain/steer path acknowledges delivery.

CREATE TABLE pending_inbound_deliveries (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  comm TEXT NOT NULL,
  account TEXT NOT NULL,
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id, comm, account)
);

CREATE INDEX idx_pending_inbound_deliveries_scope
  ON pending_inbound_deliveries(project, agent);

CREATE INDEX idx_pending_inbound_deliveries_conversation
  ON pending_inbound_deliveries(conversation_id);
