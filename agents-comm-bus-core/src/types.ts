// Core branded ID types and shared value types for the agents-comm-bus.
// v4 vocabulary freeze — see UNIVERSAL-OVERHAUL-IMPLEMENTATION-PLAN.md issue #7.

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type AgentId = Brand<string, "AgentId">;
export type CommId = Brand<string, "CommId">;
export type AccountId = Brand<string, "AccountId">;
export type SessionId = Brand<string, "SessionId">;
export type RequestId = Brand<string, "RequestId">;
export type MessageId = Brand<string, "MessageId">;
export type ConversationId = Brand<string, "ConversationId">;
export type QueryId = Brand<string, "QueryId">;

export const SCHEMA_VERSION_MESSAGE = 1 as const;
export const SCHEMA_VERSION_QUERY = 1 as const;
export const SCHEMA_VERSION_CONVERSATION = 1 as const;
export const SCHEMA_VERSION_ACCOUNT = 1 as const;
export const SCHEMA_VERSION_SESSION = 1 as const;

export interface ChatRef {
  comm: CommId;
  account: string;
  chat_native_id: string;
  thread_native_id?: string;
}

export interface Attachment {
  mime: string;
  filename: string;
  size: number;
  blob_hash?: string;
  local_path?: string;
  platform_metadata?: Record<string, unknown>;
}

export interface Origin {
  agent?: AgentId;
  session?: SessionId;
  comm?: CommId;
}

export interface Sender {
  id: string;
  display_name?: string;
  isBot: boolean;
  isForeignBot: boolean;
}
