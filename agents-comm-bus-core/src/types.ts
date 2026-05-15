/**
 * Core branded ID types and shared value objects for the agents-comm-bus.
 *
 * Phase 0: vocabulary freeze (v4). No runtime behavior — types only.
 */

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

export type AgentId = string & { readonly __brand: "AgentId" };
export type CommId = string & { readonly __brand: "CommId" };
export type AccountId = string & { readonly __brand: "AccountId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type RequestId = string & { readonly __brand: "RequestId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type QueryId = string & { readonly __brand: "QueryId" };

// ---------------------------------------------------------------------------
// Schema version constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION_MESSAGE = 1 as const;
export const SCHEMA_VERSION_QUERY = 1 as const;
export const SCHEMA_VERSION_CONVERSATION = 1 as const;
export const SCHEMA_VERSION_ACCOUNT = 1 as const;
export const SCHEMA_VERSION_SESSION = 1 as const;

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

/**
 * Identifies a chat on a communication platform.
 *
 * v4 non-negotiable #4: `account` is part of the identity from day one. A
 * chat is uniquely identified by the combination of (comm, account, chat_native_id),
 * not by chat_native_id alone — the same native id can exist under multiple
 * accounts on the same platform.
 */
export interface ChatRef {
  comm: CommId;
  account: AccountId;
  chat_native_id: string;
  thread_native_id?: string;
}

/**
 * Attachment metadata as a first-class value object (v4): not a path-only
 * helper. Carries enough metadata for platform adapters to reconstruct or
 * resolve the underlying content without re-reading the file.
 */
export interface Attachment {
  mime: string;
  filename: string;
  size: number;
  blob_hash?: string;
  local_path?: string;
  platform_metadata?: Record<string, unknown>;
}

/**
 * Where a message originated within our system. All fields optional because
 * inbound platform messages have no internal origin.
 */
export interface Origin {
  agent?: AgentId;
  session?: SessionId;
  comm?: CommId;
}

/**
 * The party who authored a message. `isBot` indicates any bot account;
 * `isForeignBot` indicates a bot that is not one of our own agents (used by
 * the bus to avoid feedback loops).
 */
export interface Sender {
  id: string;
  display_name?: string;
  isBot: boolean;
  isForeignBot: boolean;
}
