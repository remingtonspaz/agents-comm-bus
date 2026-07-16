import type { AgentId, ConversationId, SessionId } from "../types.js";
import { SCHEMA_VERSION_SESSION } from "../types.js";

/**
 * Durable session record.
 *
 * The lease fields encode the connection-lifetime model (v4 non-negotiable
 * #6): a session is exclusively held by one daemon connection at a time.
 * On connection close, the daemon releases the lease (sets
 * `lease_released_at`, clears `lease_holder_connection_id`). When an agent
 * can identify its owning process, the owner PID fields provide a second
 * liveness signal for stale-lease cleanup.
 */
export interface Session {
  schema_version: typeof SCHEMA_VERSION_SESSION;

  session_id: SessionId;
  agent: AgentId;
  project: string;
  created_at: number;

  // Lease metadata — connection lifetime is load-bearing.
  lease_holder_connection_id: string | null;
  lease_acquired_at: number | null;
  lease_released_at: number | null;
  lease_owner_process_pid: number | null;
  lease_owner_process_label: string | null;
  lease_owner_process_registered_at: number | null;

  // Daemon-instance identity stamped at lease acquire (AGE-58 boot-restore scoping).
  lease_owner_daemon_discovery_root: string | null;
  lease_owner_daemon_checkout_root: string | null;
  lease_owner_daemon_state_root: string | null;
  lease_owner_daemon_bin: string | null;
  lease_owner_daemon_authority_rank: string | null;

  // Most recent inbound conversation linkage (used by routing / steering).
  most_recent_inbound_conversation_id: ConversationId | null;

  /**
   * AGE-72: canonical JSON map of comm → account_label when the host sets
   * `AGENTS_COMM_LABELS`; null preserves today's unscoped behavior.
   */
  account_label_scope: string | null;

  status: "active" | "ended";
}
