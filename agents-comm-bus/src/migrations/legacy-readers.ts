import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

export const TRANSITION_ONLY_MARKER = "transition-only";
export const TRANSITION_CLEANUP_RELEASE = "v4.1-cleanup";

export type LegacyAgent = "claude" | "codex";
export type LegacyStateKind =
  | "last-chat"
  | "pending-permission"
  | "queue";

export interface LegacyReaderOptions {
  projectRoot: string;
  homeDir?: string;
  now?: number;
  pendingTtlMs?: number;
}

export interface LegacyCredentialCandidate {
  kind: "credential";
  agent: LegacyAgent;
  path: string;
  scope: "project" | "home";
  priority: number;
  hasBotToken: boolean;
  userIds: string[];
  credentialRef: string;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export interface LegacySessionRoot {
  kind: "session-root";
  agent: LegacyAgent;
  path: string;
  projectHint: string;
  expectedForProject: boolean;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export interface LegacyLastChat {
  chat_id: string;
  message_thread_id: string | null;
  from_user_id: string | null;
  updated_at: string | null;
}

export interface LegacyPendingPermission {
  timestamp: string;
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  prompt_type: "permission" | "question" | "plan" | string;
  chat_id: string | null;
  message_thread_id: string | null;
}

export interface LegacyQueueMessage {
  id: string;
  timestamp: number | string | null;
  text: string;
  from: string | null;
  chatId: string | null;
  imagePath?: string;
}

export interface LegacyStateFile<T> {
  kind: LegacyStateKind;
  agent: LegacyAgent;
  path: string;
  sessionRoot: string;
  value: T;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export interface LegacySkippedFile {
  kind: LegacyStateKind | "credential" | "session-root";
  agent?: LegacyAgent;
  path: string;
  reason: string;
  transition: typeof TRANSITION_ONLY_MARKER;
  cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}

export interface LegacyDiscoveryResult {
  projectRoot: string;
  homeDir: string;
  credentials: LegacyCredentialCandidate[];
  sessionRoots: LegacySessionRoot[];
  lastChats: LegacyStateFile<LegacyLastChat>[];
  pendingPermissions: LegacyStateFile<LegacyPendingPermission>[];
  queues: LegacyStateFile<LegacyQueueMessage[]>[];
  skipped: LegacySkippedFile[];
}

type ParsedJson =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      reason: string;
    };

export function legacySessionDirForProject(
  projectRoot: string,
  agent: LegacyAgent,
  homeDir = homedir(),
): string {
  const normalizedProject = resolve(projectRoot);
  const safeBase = basename(normalizedProject).replace(/[^a-zA-Z0-9-_]/g, "_");
  const hash = createHash("md5").update(normalizedProject).digest("hex").slice(0, 6);
  return join(homeDir, agent === "claude" ? ".claude-telegram" : ".codex-telegram", `${safeBase}-${hash}`);
}

export function discoverLegacyInputs(options: LegacyReaderOptions): LegacyDiscoveryResult {
  const projectRoot = resolve(options.projectRoot);
  const homeDir = options.homeDir ? resolve(options.homeDir) : homedir();
  const now = options.now ?? Date.now();
  const pendingTtlMs = options.pendingTtlMs ?? 5 * 60 * 1000;
  const skipped: LegacySkippedFile[] = [];
  const sessionRoots = discoverLegacySessionRoots(projectRoot, homeDir, skipped);
  const credentials = discoverCredentialCandidates(projectRoot, homeDir, skipped);
  const lastChats: LegacyStateFile<LegacyLastChat>[] = [];
  const pendingPermissions: LegacyStateFile<LegacyPendingPermission>[] = [];
  const queues: LegacyStateFile<LegacyQueueMessage[]>[] = [];

  for (const root of sessionRoots) {
    const lastChat = readLastChat(join(root.path, "last-chat.json"), root.agent, root.path);
    if (lastChat.ok) lastChats.push(lastChat.file);
    else if (lastChat.exists) skipped.push(skip("last-chat", root.agent, join(root.path, "last-chat.json"), lastChat.reason));

    const pending = readPendingPermission(join(root.path, "pending-permission.json"), root.agent, root.path, now, pendingTtlMs);
    if (pending.ok) pendingPermissions.push(pending.file);
    else if (pending.exists) skipped.push(skip("pending-permission", root.agent, join(root.path, "pending-permission.json"), pending.reason));

    const queue = readQueue(join(root.path, "queue.json"), root.agent, root.path);
    if (queue.ok) queues.push(queue.file);
    else if (queue.exists) skipped.push(skip("queue", root.agent, join(root.path, "queue.json"), queue.reason));
  }

  return { projectRoot, homeDir, credentials, sessionRoots, lastChats, pendingPermissions, queues, skipped };
}

function discoverCredentialCandidates(projectRoot: string, homeDir: string, skipped: LegacySkippedFile[]): LegacyCredentialCandidate[] {
  const paths: Array<{ agent: LegacyAgent; scope: "project" | "home"; path: string; priority: number }> = [
    { agent: "claude", scope: "project", path: join(projectRoot, ".claude", "telegram.json"), priority: 10 },
    { agent: "codex", scope: "project", path: join(projectRoot, ".codex", "telegram.json"), priority: 10 },
    { agent: "claude", scope: "home", path: join(homeDir, ".claude", "telegram.json"), priority: 1 },
    { agent: "codex", scope: "home", path: join(homeDir, ".codex", "telegram.json"), priority: 1 },
  ];

  const result: LegacyCredentialCandidate[] = [];
  for (const candidate of paths) {
    if (!existsSync(candidate.path)) continue;
    const parsed = readJson(candidate.path);
    if (!parsed.ok) {
      skipped.push(skip("credential", candidate.agent, candidate.path, parsed.reason));
      continue;
    }
    if (!isObject(parsed.value)) {
      skipped.push(skip("credential", candidate.agent, candidate.path, "credential file is not a JSON object"));
      continue;
    }
    const botToken = stringValue(parsed.value.botToken);
    const userIds = normalizeUserIds(parsed.value.userId);
    result.push({
      kind: "credential",
      agent: candidate.agent,
      path: candidate.path,
      scope: candidate.scope,
      priority: candidate.priority,
      hasBotToken: botToken.length > 0,
      userIds,
      credentialRef: `legacy-file:${candidate.path}`,
      transition: TRANSITION_ONLY_MARKER,
      cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    });
  }
  return result;
}

function discoverLegacySessionRoots(projectRoot: string, homeDir: string, skipped: LegacySkippedFile[]): LegacySessionRoot[] {
  const roots: LegacySessionRoot[] = [];
  for (const agent of ["claude", "codex"] as const) {
    const parent = join(homeDir, agent === "claude" ? ".claude-telegram" : ".codex-telegram");
    if (!existsSync(parent)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (error) {
      skipped.push(skip("session-root", agent, parent, error instanceof Error ? error.message : "cannot read session root"));
      continue;
    }
    const expected = legacySessionDirForProject(projectRoot, agent, homeDir);
    for (const entry of entries) {
      const path = join(parent, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      roots.push({
        kind: "session-root",
        agent,
        path,
        projectHint: entry.replace(/-[0-9a-f]{6}$/i, ""),
        expectedForProject: resolve(path) === resolve(expected),
        transition: TRANSITION_ONLY_MARKER,
        cleanupRelease: TRANSITION_CLEANUP_RELEASE,
      });
    }
  }
  return roots;
}

function readLastChat(path: string, agent: LegacyAgent, sessionRoot: string): { ok: true; file: LegacyStateFile<LegacyLastChat> } | { ok: false; exists: boolean; reason: string } {
  const parsed = readOptionalObject(path);
  if (!parsed.ok) return parsed;
  const chatId = stringValue(parsed.value.chat_id);
  if (!chatId) return { ok: false, exists: true, reason: "last-chat.json is missing chat_id" };
  return {
    ok: true,
    file: stateFile("last-chat", agent, path, sessionRoot, {
      chat_id: chatId,
      message_thread_id: nullableString(parsed.value.message_thread_id),
      from_user_id: nullableString(parsed.value.from_user_id),
      updated_at: nullableString(parsed.value.updated_at),
    }),
  };
}

function readPendingPermission(
  path: string,
  agent: LegacyAgent,
  sessionRoot: string,
  now: number,
  ttlMs: number,
): { ok: true; file: LegacyStateFile<LegacyPendingPermission> } | { ok: false; exists: boolean; reason: string } {
  const parsed = readOptionalObject(path);
  if (!parsed.ok) return parsed;
  const timestamp = stringValue(parsed.value.timestamp);
  if (!timestamp) return { ok: false, exists: true, reason: "pending-permission.json is missing timestamp" };
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, exists: true, reason: "pending-permission.json timestamp is invalid" };
  if (now - timestampMs >= ttlMs) return { ok: false, exists: true, reason: "pending permission is expired" };

  return {
    ok: true,
    file: stateFile("pending-permission", agent, path, sessionRoot, {
      timestamp,
      tool_name: nullableString(parsed.value.tool_name),
      tool_input: isObject(parsed.value.tool_input) ? parsed.value.tool_input : null,
      prompt_type: stringValue(parsed.value.prompt_type) || "permission",
      chat_id: nullableString(parsed.value.chat_id),
      message_thread_id: nullableString(parsed.value.message_thread_id),
    }),
  };
}

function readQueue(path: string, agent: LegacyAgent, sessionRoot: string): { ok: true; file: LegacyStateFile<LegacyQueueMessage[]> } | { ok: false; exists: boolean; reason: string } {
  const parsed = readOptionalObject(path);
  if (!parsed.ok) return parsed;
  const rawMessages = Array.isArray(parsed.value.messages) ? parsed.value.messages : [];
  const messages: LegacyQueueMessage[] = [];
  for (const raw of rawMessages) {
    if (!isObject(raw)) continue;
    messages.push({
      id: stringValue(raw.id),
      timestamp: typeof raw.timestamp === "number" || typeof raw.timestamp === "string" ? raw.timestamp : null,
      text: stringValue(raw.text),
      from: nullableString(raw.from),
      chatId: nullableString(raw.chatId),
      imagePath: nullableString(raw.imagePath) ?? undefined,
    });
  }
  return { ok: true, file: stateFile("queue", agent, path, sessionRoot, messages) };
}

function readOptionalObject(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; exists: boolean; reason: string } {
  if (!existsSync(path)) return { ok: false, exists: false, reason: "file does not exist" };
  const parsed = readJson(path);
  if (!parsed.ok) return { ok: false, exists: true, reason: parsed.reason };
  if (!isObject(parsed.value)) return { ok: false, exists: true, reason: "file is not a JSON object" };
  return { ok: true, value: parsed.value };
}

function readJson(path: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid JSON" };
  }
}

function normalizeUserIds(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return values.map((value) => stringValue(value).trim()).filter(Boolean);
}

function stateFile<T>(kind: LegacyStateKind, agent: LegacyAgent, path: string, sessionRoot: string, value: T): LegacyStateFile<T> {
  return {
    kind,
    agent,
    path,
    sessionRoot,
    value,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE,
  };
}

function skip(kind: LegacySkippedFile["kind"], agent: LegacyAgent | undefined, path: string, reason: string): LegacySkippedFile {
  return {
    kind,
    agent,
    path,
    reason,
    transition: TRANSITION_ONLY_MARKER,
    cleanupRelease: TRANSITION_CLEANUP_RELEASE,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return "";
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text.length > 0 ? text : null;
}
