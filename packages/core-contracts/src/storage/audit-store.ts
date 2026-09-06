// Daily-rotated JSONL audit log.
// Captures every state-changing event in the bus so operators can reconstruct
// what happened without replaying transcripts. Distinct from TranscriptStore:
// audit logs events, transcripts log message payloads.

import type { AgentId, ConversationId, SessionId } from "../types.js";

export type AuditEventKind =
  | "inbound_received"
  | "outbound_sent"
  | "outbound_failed"
  // AGE-93: comm adapter connection lifecycle transitions. Previously mapped
  // onto "outbound_failed"/"inbound_received" (bus.ts), which fabricated
  // hundreds of message-level events per day and camouflaged real failures.
  | "connection_state_changed"
  // AGE-95: MessageBus.send() failed BEFORE reaching the adapter — target
  // resolution, comm mismatch, registration resolution, or adapter-not-
  // registered. Previously audited as nothing at all. Distinct from
  // outbound_failed (adapter attempted delivery and failed) so the kinds
  // don't re-blur.
  | "outbound_routing_failed"
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
  | "agent_wake_target_invalid"
  | "inbound_dispatch_enqueued"
  | "inbound_dispatch_bridge_invoked"
  | "inbound_dispatch_bridge_completed"
  | "inbound_dispatch_bridge_failed"
  | "daemon_superseded"
  | "daemon_claim_lost"
  | "daemon_discovery_foreign_owner_replaced"
  | "daemon_discovery_reclaimed"
  | "daemon_pid_watchdog_error"
  | "daemon_retired"
  | "comm_lease_acquired"
  | "comm_lease_reclaimed"
  | "comm_lease_denied"
  | "comm_lease_lost"
  | "comm_lease_released"
  | "comm_lease_reaped"
  | "comm_lease_sweep_failed"
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
  | "daemon_boot_restore"
  // AGE-57: wake trigger/response write or hydration miss (previously stderr-only).
  | "wake_delivery_failure"
  // AGE-57: stale pid/port discovery files removed during ensureDaemon bootstrap.
  | "discovery_stale_cleanup"
  | "daemon_discovery_foreign_state_root"
  | "daemon_discovery_state_root_unknown"
  | "daemon_terminate_skipped_identity_unknown"
  // AGE-57: adapter/credential skip not already covered by actionable console logs.
  | "comm_adapter_skip"
  // AGE-56: in-memory pending queue overflow spilled oldest entries; durable rows remain.
  | "pending_inbound_overflow_spill"
  // AGE-56: durable pending row could not be replayed from transcript storage.
  | "durable_inbound_replay_miss"
  // AGE-43: credential file exists but failed to parse or validate.
  | "credential_resolution_failed"
  // AGE-72: configured account_label_scope has no matching registration rows.
  | "account_label_scope_miss";

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
  /** Optional probe for crash-resume idempotency (AGE-96 curl path). */
  hasInboundReceived?(
    conversation_id: ConversationId,
    message: Pick<import("../messages.js").Message, "platform_message_id">,
    auditTimestamp?: number,
  ): Promise<boolean>;
}
