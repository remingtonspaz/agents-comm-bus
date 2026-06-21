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

// AGE-65: the wake "seed" is the inbound message text typed verbatim into the
// Claude prompt slot (so the auto-mode classifier sees real user intent instead
// of a bare "."). It must be a single line — a newline would submit the prompt
// mid-message — and bounded so a pathological message can't make the watcher type
// for too long (validated reliable to ~2000 chars at 2ms/char). The hook's
// [Daemon Inbound Messages] block remains the authoritative full-content +
// routing channel; this seed is best-effort prompt-slot/classifier affordance.
export const WAKE_SEED_MAX_CHARS = 2000;

export function sanitizeWakeSeed(text: string | undefined): string {
  if (!text) return "";
  const singleLine = text.replace(/[\r\n]+/g, " ").trim();
  return singleLine.length > WAKE_SEED_MAX_CHARS
    ? singleLine.slice(0, WAKE_SEED_MAX_CHARS)
    : singleLine;
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
    // AGE-65: drop the inbound text as a seed BEFORE the trigger so it is in
    // place when the watcher consumes the trigger. Best-effort: a seed write
    // failure must not block the wake itself.
    const seed = sanitizeWakeSeed(message?.text);
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
