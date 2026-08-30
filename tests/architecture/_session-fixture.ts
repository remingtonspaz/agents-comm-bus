import type { Session } from "../../packages/core-contracts/src/records/index.js";
import { SCHEMA_VERSION_SESSION } from "../../packages/core-contracts/src/types.js";

/** Null daemon-owner metadata stamped at lease acquire (AGE-58). */
export const NULL_SESSION_DAEMON_OWNER: Pick<
  Session,
  | "lease_owner_daemon_discovery_root"
  | "lease_owner_daemon_checkout_root"
  | "lease_owner_daemon_state_root"
  | "lease_owner_daemon_bin"
  | "lease_owner_daemon_authority_rank"
> = {
  lease_owner_daemon_discovery_root: null,
  lease_owner_daemon_checkout_root: null,
  lease_owner_daemon_state_root: null,
  lease_owner_daemon_bin: null,
  lease_owner_daemon_authority_rank: null,
};

/** Null host-process owner metadata for sessions without a stamped pid. */
export const NULL_SESSION_PROCESS_OWNER: Pick<
  Session,
  | "lease_owner_process_pid"
  | "lease_owner_process_label"
  | "lease_owner_process_registered_at"
  | "lease_owner_process_start_time"
> = {
  lease_owner_process_pid: null,
  lease_owner_process_label: null,
  lease_owner_process_registered_at: null,
  lease_owner_process_start_time: null,
};

const NULL_SESSION_LEASE_HOLDER: Pick<
  Session,
  "lease_holder_connection_id" | "lease_acquired_at" | "lease_released_at"
> = {
  lease_holder_connection_id: null,
  lease_acquired_at: null,
  lease_released_at: null,
};

/**
 * Build a durable Session record with AGE-58 daemon-owner fields present.
 * Callers supply identity fields; everything else defaults to inactive/null.
 */
export function sessionFixture(
  overrides: Partial<Session> & Pick<Session, "session_id" | "agent" | "project">,
): Session {
  return {
    schema_version: SCHEMA_VERSION_SESSION,
    created_at: 1,
    ...NULL_SESSION_LEASE_HOLDER,
    ...NULL_SESSION_PROCESS_OWNER,
    ...NULL_SESSION_DAEMON_OWNER,
    most_recent_inbound_conversation_id: null,
    account_label_scope: null,
    status: "active",
    ...overrides,
  };
}
