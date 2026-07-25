import crypto from "node:crypto";
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
import {
  parseAccountLabelScope,
  resolveSessionForConversation,
  serializeAccountLabelScope,
} from "../../session-label-scope.js";
import {
  createSessionOwnerLiveness,
  type SessionOwnerLiveness,
} from "../../runtime/session-owner-liveness.js";

export interface ClaudeWakeRegistration {
  session: SessionId;
  project: string;
  wakeDir: string;
  registeredAt: number;
  account_label_scope: string | null;
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
  accountLabelScope: string | null = null,
): string {
  const canonical = normalizeProjectPath(projectPath);
  const basename = path.basename(canonical) || "project";
  const legacyDir = `${basename}-${hashProjectKey(canonical)}`;
  let canonicalScope: string | null;
  try {
    canonicalScope = serializeAccountLabelScope(
      parseAccountLabelScope(accountLabelScope),
    );
  } catch (error) {
    console.error(
      "agents-comm-bus: invalid persisted Claude account_label_scope; " +
        "using a scope-inert wake directory: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    // Never collapse a corrupt non-null scope onto the legacy catch-all dir.
    canonicalScope = `__invalid__:${accountLabelScope}`;
  }
  return path.join(
    homeDir,
    ".agents-comm-bus",
    "claude-wake",
    "sessions",
    canonicalScope
      ? `${legacyDir}-${crypto.createHash("sha256").update(canonicalScope).digest("hex").slice(0, 12)}`
      : legacyDir,
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

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sessionOwnerIsLive: SessionOwnerLiveness =
      createSessionOwnerLiveness(),
  ) {}

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
    account_label_scope?: string | null;
  }): ClaudeWakeRegistration {
    const project = normalizeProjectPath(input.project);
    const registration: ClaudeWakeRegistration = {
      session: input.session,
      project,
      wakeDir:
        input.wakeDir ??
        claudeWakeDirForProject(
          project,
          os.homedir(),
          input.account_label_scope ?? null,
        ),
      registeredAt: this.now(),
      account_label_scope: input.account_label_scope ?? null,
    };
    this.registrations.set(input.session, registration);
    return registration;
  }

  latestForProject(
    project: string,
    conversation?: { comm: string; account_label: string },
  ): ClaudeWakeRegistration | undefined {
    const resolved = normalizeProjectPath(project);
    const candidates = [...this.registrations.values()].filter(
      (registration) => registration.project === resolved,
    );
    if (candidates.length === 0) return undefined;
    if (!conversation) {
      let latest: ClaudeWakeRegistration | undefined;
      for (const registration of candidates) {
        if (!latest || registration.registeredAt > latest.registeredAt) {
          latest = registration;
        }
      }
      return latest;
    }
    const match = resolveSessionForConversation(
      candidates.map((registration) => ({
        project: registration.project,
        agent: "claude",
        account_label_scope: registration.account_label_scope,
        session_id: registration.session,
      })),
      conversation,
      (candidate) => candidate.session_id,
    );
    if (match) {
      return candidates.find((registration) => registration.session === match.session_id);
    }
    const unlabeled = candidates.filter((registration) => registration.account_label_scope == null);
    if (unlabeled.length === 1) return unlabeled[0];
    return undefined;
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
      this.latestForProject(conversation.project, conversation) ??
      (await this.hydrateLatestForProject(conversation.project, conversation));
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
   * is deterministic from persisted project + label scope, so reconstruction
   * is lossless even across daemon restarts.
   */
  private async hydrateLatestForProject(
    project: string,
    conversation?: { comm: string; account_label: string },
  ): Promise<ClaudeWakeRegistration | undefined> {
    if (!this.storage) return undefined;
    const resolved = normalizeProjectPath(project);
    const sessions = await this.storage.listSessions({
      project: resolved,
      agent: "claude" as AgentId,
      status: "active",
    });
    if (sessions.length === 0) return undefined;
    const live = sessions.filter(this.sessionOwnerIsLive);
    const pool = live.length > 0 ? live : sessions;
    let match = conversation
      ? resolveSessionForConversation(pool, conversation, (sess) => sess.session_id)
      : pool[0];
    if (conversation && !match) {
      // Multiple legacy/unscoped rows are ambiguous by session id but share
      // the exact same project-only wake directory. Reaching this branch also
      // proves no labeled scope matched, so unrelated labeled rows must not
      // veto the legacy fallback.
      match = pool.find(
        (session) => session.account_label_scope == null,
      );
      if (!match) return undefined;
    }
    const latest = match;
    if (!latest) return undefined;
    return this.register({
      session: latest.session_id,
      project: resolved,
      account_label_scope: latest.account_label_scope,
    });
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
    return this.register({
      session,
      project: record.project,
      account_label_scope: record.account_label_scope,
    });
  }
}
