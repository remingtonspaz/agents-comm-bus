import type { AgentId, CommId } from "../types.js";
import { SCHEMA_VERSION_ACCOUNT } from "../types.js";

/** AGE-97: lazy = session-triggered only; eager = daemon brings adapter up without a live session. */
export type AccountActivation = "lazy" | "eager";

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

  // Immutable surrogate identity (AGE-20). Generated once at account-add and
  // never changes — notably it survives an account-update-token bot replacement
  // (which mutates bot_user_id). Phase 1 adds it additively; later phases make
  // it the canonical primary key.
  registration_id: string;

  // Primary key
  project: string;
  comm: CommId;
  agent: AgentId;
  account_label: string;

  // Unique with `comm`
  bot_user_id: string;

  // Opaque pointer/handle — credentials are NOT stored inline.
  credentials_ref: string;

  /** AGE-97: default lazy — eager activates at daemon boot / flag-set without a live session. */
  activation: AccountActivation;

  bot_username?: string;
  created_at: number;
  updated_at: number;
  metadata?: Record<string, unknown>;
}
