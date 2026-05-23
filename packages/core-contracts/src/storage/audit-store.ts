// Daily-rotated JSONL audit log.
// Captures every state-changing event in the bus so operators can reconstruct
// what happened without replaying transcripts. Distinct from TranscriptStore:
// audit logs events, transcripts log message payloads.

import type { AgentId, ConversationId, SessionId } from "../types.js";

export type AuditEventKind =
  | "inbound_received"
  | "outbound_sent"
  | "outbound_failed"
  | "query_opened"
  | "query_resolved"
  | "query_expired"
  | "query_rejected_stale"
  | "session_lease_acquired"
  | "session_lease_released"
  | "registration_added"
  | "registration_removed"
  | "loop_prevention_drop";

export interface AuditEvent {
  timestamp: number;
  kind: AuditEventKind;
  agent?: AgentId;
  session?: SessionId;
  conversation_id?: ConversationId;
  detail?: Record<string, unknown>;
}

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
}
