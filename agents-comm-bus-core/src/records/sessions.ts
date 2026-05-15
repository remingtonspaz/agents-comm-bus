import type { AgentId, ConversationId, SessionId } from "../types.js";
import { SCHEMA_VERSION_SESSION } from "../types.js";

/**
 * Durable session record.
 *
 * The lease fields encode the connection-lifetime model (v4 non-negotiable
 * #6): a session is exclusively held by one daemon connection at a time.
 * On connection close, the daemon releases the lease (sets
 * `lease_released_at`, clears `lease_holder_connection_id`). The lifetime
 * of a connection is load-bearing for cleanup and recovery semantics.
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

  // Most recent inbound conversation linkage (used by routing / steering).
  most_recent_inbound_conversation_id: ConversationId | null;

  status: "active" | "ended";
}
