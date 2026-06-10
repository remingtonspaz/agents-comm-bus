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
  | "agent_wake_attempt"
  | "agent_wake_succeeded"
  | "agent_wake_failed"
  | "agent_wake_skipped"
  | "inbound_dispatch_enqueued"
  | "inbound_dispatch_bridge_invoked"
  | "inbound_dispatch_bridge_completed"
  | "inbound_dispatch_bridge_failed"
  | "daemon_superseded"
  | "daemon_discovery_reclaimed"
  | "daemon_pid_watchdog_error"
  | "comm_lease_acquired"
  | "comm_lease_reclaimed"
  | "comm_lease_denied"
  | "comm_lease_lost"
  | "comm_lease_released"
  | "registration_added"
  | "registration_removed"
  // AGE-52: session registered for a project with no exact registration row,
  // but stored rows exist whose canonical form matches (path casing/separator drift).
  | "registration_project_near_miss"
  | "loop_prevention_drop"
  // AGE-10: an inbound update dropped by an ADAPTER-level filter (allowlist /
  // missing sender id) before it reached the bus — previously silent.
  | "inbound_filter_drop"
  // AGE-9: a bare text reply matched more than one open query; the answer
  // attempt was consumed and a disambiguation helper was sent instead.
  | "query_ambiguous_reply"
  // AGE-55: boot-time liveness-gated comm-scope restore summary.
  | "daemon_boot_restore";

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
