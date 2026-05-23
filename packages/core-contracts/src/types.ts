// Branded ID types and shared primitives for the agents-comm-bus.
// Branded strings prevent accidental cross-type mixups at compile time.

export type AgentId = string & { readonly __brand: "AgentId" };
export type CommId = string & { readonly __brand: "CommId" };
export type AccountId = string & { readonly __brand: "AccountId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type RequestId = string & { readonly __brand: "RequestId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type QueryId = string & { readonly __brand: "QueryId" };

// Schema-version constants. Bump when a record shape changes incompatibly.
export const SCHEMA_VERSION_MESSAGE = 1 as const;
export const SCHEMA_VERSION_QUERY = 1 as const;
export const SCHEMA_VERSION_CONVERSATION = 1 as const;
export const SCHEMA_VERSION_ACCOUNT = 1 as const;
export const SCHEMA_VERSION_SESSION = 1 as const;

export interface ChatRef {
  comm: CommId;
  account: AccountId;
  chat_native_id: string;
  thread_native_id?: string;
}

export interface Attachment {
  mime: string;
  filename: string;
  size: number;
  blob_hash?: string;
  local_path?: string;
  platform_metadata?: Readonly<Record<string, unknown>>;
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
