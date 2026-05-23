import type { AgentId, CommId } from "../types.js";
import { SCHEMA_VERSION_ACCOUNT } from "../types.js";

/**
 * Durable record for an account registered on a specific comm under a
 * specific agent within a project.
 *
 * Primary key: (project, comm, agent, account_label).
 *
 * Uniqueness: (comm, bot_user_id) — a given bot identity on a comm can be
 * registered at most once.
 *
 * Credentials are NEVER stored inline; `credentials_ref` is an opaque
 * pointer (e.g. a keyring handle or vault key) the daemon resolves at use
 * time.
 */
export interface AccountRegistration {
  schema_version: typeof SCHEMA_VERSION_ACCOUNT;

  // Primary key
  project: string;
  comm: CommId;
  agent: AgentId;
  account_label: string;

  // Unique with `comm`
  bot_user_id: string;

  // Opaque pointer/handle — credentials are NOT stored inline.
  credentials_ref: string;

  bot_username?: string;
  created_at: number;
  updated_at: number;
  metadata?: Record<string, unknown>;
}
