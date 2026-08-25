-- AGE-96: durable curl inbound idempotency receipts (scoped recovery markers).

CREATE TABLE curl_inbound_receipts (
  registration_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  client_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
  reserved_at INTEGER NOT NULL,
  accepted_at INTEGER,
  expires_at INTEGER NOT NULL,
  transcript_recorded_at INTEGER,
  audit_recorded_at INTEGER,
  dispatch_recorded_at INTEGER,
  query_consumed_at INTEGER,
  planned_query_id TEXT,
  PRIMARY KEY (registration_id, sender_id, client_key)
);

CREATE INDEX idx_curl_inbound_receipts_expires
  ON curl_inbound_receipts(expires_at);
