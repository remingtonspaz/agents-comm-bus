// Stable identifier types
export type AgentId = string;
export type CommId = string;
export type AccountId = string;
export type SessionId = string;
export type RequestId = string;
export type MessageId = string;

// Schema versioning constants
export const SCHEMA_VERSION_MESSAGE = 1 as const;
export const SCHEMA_VERSION_PERMISSION = 1 as const;
export const SCHEMA_VERSION_BINDING = 1 as const;
export const SCHEMA_VERSION_TRANSCRIPT = 1 as const;

// Routing target identity
export interface ChatRef {
  comm: CommId;
  account: AccountId;
  id: string;
  thread_id?: string;
}

// Attachment value object (replaces sendImage(path) at the daemon boundary)
export interface Attachment {
  mime: string;
  filename: string;
  size: number;
  blob_ref?: string;
  local_path?: string;
  platform_metadata?: Record<string, unknown>;
}

// Origin labeling for loop prevention and audit
export interface Origin {
  agent?: AgentId;
  session?: SessionId;
  comm?: CommId;
}

// Sender identity (with foreign-bot tagging support)
export interface Sender {
  id: string;
  display_name?: string;
  isBot: boolean;
  isForeignBot: boolean;
}

// Normalized inbound/outbound message
export interface Message {
  schema_version: typeof SCHEMA_VERSION_MESSAGE;
  message_id: MessageId;
  chat: ChatRef;
  sender: Sender;
  origin: Origin;
  text?: string;
  attachments?: Attachment[];
  reply_to?: MessageId;
  hop_count: number;
  received_at: number;
}

// Permission request lifecycle
export type PermissionKind =
  | "tool"
  | "ask_user_question"
  | "plan_mode"
  | "interrupt"
  | "steer"
  | "slash_command";

export interface PermissionRequest {
  schema_version: typeof SCHEMA_VERSION_PERMISSION;
  request_id: RequestId;
  agent: AgentId;
  session: SessionId;
  kind: PermissionKind;
  source_chat?: ChatRef;
  source_message_id?: MessageId;
  prompt_text: string;
  options?: Array<{ label: string; description?: string }>;
  created_at: number;
  ttl_ms: number;
}

export type PermissionDecisionKind =
  | "allow"
  | "deny"
  | "always_allow"
  | "select_option";

export interface PermissionDecision {
  request_id: RequestId;
  decision: PermissionDecisionKind;
  selected_option_index?: number;
  decided_by_sender_id: string;
  decided_in_chat: ChatRef;
  decided_at: number;
}
