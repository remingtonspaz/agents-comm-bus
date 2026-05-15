import type { ConversationId } from "../../../agents-comm-bus-core/dist/types.js";
import type { LegacyLastChat, LegacyStateFile } from "./legacy-readers.js";
import { TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER } from "./legacy-readers.js";

export interface ImportedLastChatConversation {
  conversation_id: ConversationId;
  agent: string;
  project: string;
  comm: "telegram";
  account_label: string;
  chat_native_id: string;
  thread_native_id: string | null;
  last_inbound_at: number | null;
  last_inbound_sender_id: string | null;
  source_file: string;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export type ImportLastChatResult =
  | {
      status: "imported";
      record: ImportedLastChatConversation;
      audit: TransitionImportAudit;
    }
  | {
      status: "skipped";
      reason: string;
      source_file: string;
      audit: TransitionImportAudit;
    };

export interface TransitionImportAudit {
  kind: "legacy_state_imported" | "legacy_state_skipped";
  source: "last-chat";
  path: string;
  reason?: string;
  detail: Record<string, unknown>;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export interface ImportLastChatOptions {
  project: string;
  accountLabel?: string;
}

export function importLastChat(file: LegacyStateFile<LegacyLastChat>, options: ImportLastChatOptions): ImportLastChatResult {
  const chatId = file.value.chat_id?.trim();
  if (!chatId) return skipped(file.path, "missing chat_id");

  const updatedAt = file.value.updated_at ? Date.parse(file.value.updated_at) : NaN;
  const conversationId = stableConversationId(options.project, file.agent, options.accountLabel ?? "legacy", chatId, file.value.message_thread_id);
  const record: ImportedLastChatConversation = {
    conversation_id: conversationId,
    agent: file.agent,
    project: options.project,
    comm: "telegram",
    account_label: options.accountLabel ?? "legacy",
    chat_native_id: chatId,
    thread_native_id: file.value.message_thread_id,
    last_inbound_at: Number.isFinite(updatedAt) ? updatedAt : null,
    last_inbound_sender_id: file.value.from_user_id,
    source_file: file.path,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE,
  };

  return {
    status: "imported",
    record,
    audit: {
      kind: "legacy_state_imported",
      source: "last-chat",
      path: file.path,
      detail: {
        agent: file.agent,
        chat_native_id: chatId,
        thread_native_id: file.value.message_thread_id,
        imported_as: "conversation-inventory",
      },
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    },
  };
}

function skipped(path: string, reason: string): ImportLastChatResult {
  return {
    status: "skipped",
    reason,
    source_file: path,
    audit: {
      kind: "legacy_state_skipped",
      source: "last-chat",
      path,
      reason,
      detail: {},
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    },
  };
}

function stableConversationId(project: string, agent: string, accountLabel: string, chatId: string, threadId: string | null): ConversationId {
  return `legacy:${project}:${agent}:telegram:${accountLabel}:${chatId}:${threadId ?? ""}` as ConversationId;
}
