import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentId,
  Conversation,
  Message,
  SessionId,
  Storage,
} from "agents-comm-bus-core";

import { normalizeProjectPath } from "../../project-path.js";

export interface ClaudeWakeRegistration {
  session: SessionId;
  project: string;
  wakeDir: string;
  registeredAt: number;
}

export function hashProjectKey(projectPath: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectPath.length; i += 1) {
    hash ^= projectPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function claudeWakeDirForProject(
  projectPath: string,
  homeDir = os.homedir(),
): string {
  const canonical = normalizeProjectPath(projectPath);
  const basename = path.basename(canonical) || "project";
  return path.join(
    homeDir,
    ".agents-comm-bus",
    "claude-wake",
    "sessions",
    `${basename}-${hashProjectKey(canonical)}`,
  );
}

export async function writeClaudeWakeTrigger(
  wakeDir: string,
  now: () => number = Date.now,
): Promise<void> {
  await mkdir(wakeDir, { recursive: true });
  await writeFile(path.join(wakeDir, "trigger-enter"), `${now()}\n`, "utf8");
}

// AGE-65: the wake "seed" is the inbound message typed into the Claude prompt
// slot (so the auto-mode classifier sees real user intent instead of a bare ".").
// It is DECORATED with the comm + sender ("<comm> message from <sender>: <body>")
// so another agent's message (Codex/Pi) can't be misread as the user's. Newlines
// are PRESERVED — the watcher types each as backslash+Enter for a real multi-line
// TUI prompt — while other control chars are stripped and the whole is bounded.
// The hook's [Daemon Inbound Messages] block stays the authoritative full-content
// + routing channel; this seed is best-effort.
export const WAKE_SEED_MAX_CHARS = 2000;

// Normalize CRLF->LF, keep newlines (0x0A), strip other control chars, cap, trim.
export function sanitizeWakeSeed(text: string | undefined): string {
  if (!text) return "";
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
    .trim();
  return normalized.length > WAKE_SEED_MAX_CHARS
    ? normalized.slice(0, WAKE_SEED_MAX_CHARS)
    : normalized;
}

// Build the decorated, sanitized seed. The "<comm> message from <sender>:" prefix
// attributes the message so a Codex/Pi message isn't misconstrued as the user's.
// Returns "" when there's no text to seed (e.g. attachment-only) -> bare "." wake.
export function buildWakeSeed(input: {
  comm?: string;
  sender?: string;
  body?: string;
}): string {
  const body = (input.body ?? "").trim();
  if (!body) return "";
  const comm = input.comm && input.comm.length > 0 ? input.comm : "message";
  const sender =
    input.sender && input.sender.length > 0 ? input.sender : "unknown sender";
  return sanitizeWakeSeed(`${comm} message from ${sender}: ${body}`);
}

export async function writeClaudeWakeSeed(
  wakeDir: string,
  text: string,
): Promise<void> {
  await mkdir(wakeDir, { recursive: true });
  await writeFile(path.join(wakeDir, "wake-seed.txt"), text, "utf8");
}

export type ClaudeWakeResponsePromptType = "permission" | "question" | "freetext";

export interface ClaudeWakeResponsePayload {
  response: string;
  prompt_type: ClaudeWakeResponsePromptType;
}

export async function writeClaudeWakeResponse(
  wakeDir: string,
  payload: ClaudeWakeResponsePayload,
): Promise<void> {
  await mkdir(wakeDir, { recursive: true });
  await writeFile(
    path.join(wakeDir, "permission-response.json"),
    JSON.stringify(payload),
    "utf8",
  );
}

export class ClaudeWakeRegistry {
  private readonly registrations = new Map<SessionId, ClaudeWakeRegistration>();
  private storage: Storage | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Inject the daemon's storage so wake lookups can fall back to the
   * persisted `sessions` table when the in-memory map is empty (e.g. after
   * a daemon restart, before the agent's MCP shim / hooks have re-issued
   * `claude_register_session`). The Claude wake_dir is deterministic from
   * project, so no extra schema column is needed — the session row's
   * `project` is enough to reconstruct the dir via
   * `claudeWakeDirForProject`.
   */
  setStorage(storage: Storage): void {
    this.storage = storage;
  }

  register(input: {
    session: SessionId;
    project: string;
    wakeDir?: string;
  }): ClaudeWakeRegistration {
    const project = normalizeProjectPath(input.project);
    const registration: ClaudeWakeRegistration = {
      session: input.session,
      project,
      wakeDir: input.wakeDir ?? claudeWakeDirForProject(project),
      registeredAt: this.now(),
    };
    this.registrations.set(input.session, registration);
    return registration;
  }

  latestForProject(project: string): ClaudeWakeRegistration | undefined {
    const resolved = normalizeProjectPath(project);
    let latest: ClaudeWakeRegistration | undefined;
    for (const registration of this.registrations.values()) {
      if (registration.project !== resolved) continue;
      if (!latest || registration.registeredAt > latest.registeredAt) {
        latest = registration;
      }
    }
    return latest;
  }

  getForSession(session: SessionId): ClaudeWakeRegistration | undefined {
    return this.registrations.get(session);
  }

  async writeResponseForSession(
    session: SessionId,
    payload: ClaudeWakeResponsePayload,
  ): Promise<boolean> {
    const registration =
      this.registrations.get(session) ??
      (await this.hydrateRegistrationForSession(session));
    if (!registration) return false;
    await writeClaudeWakeResponse(registration.wakeDir, payload);
    await writeClaudeWakeTrigger(registration.wakeDir, this.now);
    return true;
  }

  async wakeConversation(
    conversation: Conversation,
    message?: Message,
  ): Promise<boolean> {
    if (conversation.agent !== ("claude" as AgentId)) return false;
    const registration =
      this.latestForProject(conversation.project) ??
      (await this.hydrateLatestForProject(conversation.project));
    if (!registration) return false;
    // AGE-65: drop the decorated inbound text as a seed BEFORE the trigger so it
    // is in place when the watcher consumes the trigger. Best-effort: a seed
    // write failure must not block the wake itself.
    const seed = buildWakeSeed({
      comm: message?.chat.comm,
      sender: message?.sender?.display_name ?? message?.sender?.id,
      body: message?.text,
    });
    if (seed) {
      try {
        await writeClaudeWakeSeed(registration.wakeDir, seed);
      } catch {
        /* best-effort: fall back to a bare "." wake */
      }
    }
    await writeClaudeWakeTrigger(registration.wakeDir, this.now);
    return true;
  }

  /**
   * On a miss in `wakeConversation`, look up the most recent Claude session
   * for this project from storage and seed the in-memory map. The wake_dir
   * is deterministic from project, so reconstruction is lossless even
   * across daemon restarts.
   */
  private async hydrateLatestForProject(
    project: string,
  ): Promise<ClaudeWakeRegistration | undefined> {
    if (!this.storage) return undefined;
    const resolved = normalizeProjectPath(project);
    const sessions = await this.storage.listSessions({
      project: resolved,
      agent: "claude" as AgentId,
    });
    if (sessions.length === 0) return undefined;
    const latest = sessions[0]; // listSessions orders by created_at DESC.
    return this.register({ session: latest.session_id, project: resolved });
  }

  /**
   * On a miss in `writeResponseForSession`, look up the specific session
   * row in storage and reconstruct its wake registration so we can write
   * the wake response after a daemon restart.
   */
  private async hydrateRegistrationForSession(
    session: SessionId,
  ): Promise<ClaudeWakeRegistration | undefined> {
    if (!this.storage) return undefined;
    const record = await this.storage.getSession(session);
    if (!record || record.agent !== ("claude" as AgentId)) return undefined;
    return this.register({ session, project: record.project });
  }
}
