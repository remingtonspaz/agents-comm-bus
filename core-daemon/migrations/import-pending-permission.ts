import type { QueryId, SessionId } from "agents-comm-bus-core";
import type { LegacyPendingPermission, LegacyStateFile } from "./legacy-readers.js";
import { TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER } from "./legacy-readers.js";

export interface ImportedPendingPermissionQuery {
  query_id: QueryId;
  agent: string;
  session: SessionId;
  kind: "approval" | "choice";
  prompt_text: string;
  created_at: number;
  ttl_seconds: number;
  chat_native_id: string | null;
  thread_native_id: string | null;
  source_file: string;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export type ImportPendingPermissionResult =
  | {
      status: "imported";
      record: ImportedPendingPermissionQuery;
      audit: TransitionPendingAudit;
    }
  | {
      status: "skipped";
      reason: string;
      source_file: string;
      audit: TransitionPendingAudit;
    };

export interface TransitionPendingAudit {
  kind: "legacy_state_imported" | "legacy_state_skipped";
  source: "pending-permission";
  path: string;
  reason?: string;
  detail: Record<string, unknown>;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export interface ImportPendingPermissionOptions {
  sessionId: SessionId;
  now?: number;
  ttlSeconds?: number;
}

export function importPendingPermission(
  file: LegacyStateFile<LegacyPendingPermission>,
  options: ImportPendingPermissionOptions,
): ImportPendingPermissionResult {
  const createdAt = Date.parse(file.value.timestamp);
  if (!Number.isFinite(createdAt)) return skipped(file.path, "invalid timestamp");

  const ttlSeconds = options.ttlSeconds ?? 300;
  const now = options.now ?? Date.now();
  if (now - createdAt >= ttlSeconds * 1000) return skipped(file.path, "pending permission is expired");

  const kind = file.value.prompt_type === "question" ? "choice" : "approval";
  const record: ImportedPendingPermissionQuery = {
    query_id: `legacy:${file.agent}:${createdAt}:${file.value.tool_name ?? "permission"}` as QueryId,
    agent: file.agent,
    session: options.sessionId,
    kind,
    prompt_text: promptText(file.value),
    created_at: createdAt,
    ttl_seconds: ttlSeconds,
    chat_native_id: file.value.chat_id,
    thread_native_id: file.value.message_thread_id,
    source_file: file.path,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE,
  };

  return {
    status: "imported",
    record,
    audit: {
      kind: "legacy_state_imported",
      source: "pending-permission",
      path: file.path,
      detail: {
        agent: file.agent,
        prompt_type: file.value.prompt_type,
        imported_as: "query",
      },
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    },
  };
}

function skipped(path: string, reason: string): ImportPendingPermissionResult {
  return {
    status: "skipped",
    reason,
    source_file: path,
    audit: {
      kind: "legacy_state_skipped",
      source: "pending-permission",
      path,
      reason,
      detail: {},
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    },
  };
}

function promptText(value: LegacyPendingPermission): string {
  const toolName = value.tool_name ?? "PermissionRequest";
  if (value.prompt_type === "question") return `${toolName} question`;
  if (value.prompt_type === "plan") return `${toolName} plan approval`;
  return `${toolName} approval`;
}
