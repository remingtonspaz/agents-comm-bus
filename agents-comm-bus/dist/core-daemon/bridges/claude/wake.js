import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProjectPath } from "../../project-path.js";
import { resolveSessionForConversation, } from "../../session-label-scope.js";
export function hashProjectKey(projectPath) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < projectPath.length; i += 1) {
        hash ^= projectPath.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
export function claudeWakeDirForProject(projectPath, homeDir = os.homedir()) {
    const canonical = normalizeProjectPath(projectPath);
    const basename = path.basename(canonical) || "project";
    return path.join(homeDir, ".agents-comm-bus", "claude-wake", "sessions", `${basename}-${hashProjectKey(canonical)}`);
}
export async function writeClaudeWakeTrigger(wakeDir, now = Date.now) {
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
export function sanitizeWakeSeed(text) {
    if (!text)
        return "";
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
export function buildWakeSeed(input) {
    const body = (input.body ?? "").trim();
    if (!body)
        return "";
    const comm = input.comm && input.comm.length > 0 ? input.comm : "message";
    const sender = input.sender && input.sender.length > 0 ? input.sender : "unknown sender";
    return sanitizeWakeSeed(`${comm} message from ${sender}: ${body}`);
}
export async function writeClaudeWakeSeed(wakeDir, text) {
    await mkdir(wakeDir, { recursive: true });
    await writeFile(path.join(wakeDir, "wake-seed.txt"), text, "utf8");
}
export async function writeClaudeWakeResponse(wakeDir, payload) {
    await mkdir(wakeDir, { recursive: true });
    await writeFile(path.join(wakeDir, "permission-response.json"), JSON.stringify(payload), "utf8");
}
export class ClaudeWakeRegistry {
    now;
    registrations = new Map();
    storage = null;
    constructor(now = Date.now) {
        this.now = now;
    }
    /**
     * Inject the daemon's storage so wake lookups can fall back to the
     * persisted `sessions` table when the in-memory map is empty (e.g. after
     * a daemon restart, before the agent's MCP shim / hooks have re-issued
     * `claude_register_session`). The Claude wake_dir is deterministic from
     * project, so no extra schema column is needed — the session row's
     * `project` is enough to reconstruct the dir via
     * `claudeWakeDirForProject`.
     */
    setStorage(storage) {
        this.storage = storage;
    }
    register(input) {
        const project = normalizeProjectPath(input.project);
        const registration = {
            session: input.session,
            project,
            wakeDir: input.wakeDir ?? claudeWakeDirForProject(project),
            registeredAt: this.now(),
            account_label_scope: input.account_label_scope ?? null,
        };
        this.registrations.set(input.session, registration);
        return registration;
    }
    latestForProject(project, conversation) {
        const resolved = normalizeProjectPath(project);
        const candidates = [...this.registrations.values()].filter((registration) => registration.project === resolved);
        if (candidates.length === 0)
            return undefined;
        if (!conversation) {
            let latest;
            for (const registration of candidates) {
                if (!latest || registration.registeredAt > latest.registeredAt) {
                    latest = registration;
                }
            }
            return latest;
        }
        const match = resolveSessionForConversation(candidates.map((registration) => ({
            project: registration.project,
            agent: "claude",
            account_label_scope: registration.account_label_scope,
            session_id: registration.session,
        })), conversation, (candidate) => candidate.session_id);
        if (match) {
            return candidates.find((registration) => registration.session === match.session_id);
        }
        const unlabeled = candidates.filter((registration) => registration.account_label_scope == null);
        if (unlabeled.length === 1)
            return unlabeled[0];
        return undefined;
    }
    getForSession(session) {
        return this.registrations.get(session);
    }
    async writeResponseForSession(session, payload) {
        const registration = this.registrations.get(session) ??
            (await this.hydrateRegistrationForSession(session));
        if (!registration)
            return false;
        await writeClaudeWakeResponse(registration.wakeDir, payload);
        await writeClaudeWakeTrigger(registration.wakeDir, this.now);
        return true;
    }
    async wakeConversation(conversation, message) {
        if (conversation.agent !== "claude")
            return false;
        const registration = this.latestForProject(conversation.project, conversation) ??
            (await this.hydrateLatestForProject(conversation.project, conversation));
        if (!registration)
            return false;
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
            }
            catch {
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
    async hydrateLatestForProject(project, conversation) {
        if (!this.storage)
            return undefined;
        const resolved = normalizeProjectPath(project);
        const sessions = await this.storage.listSessions({
            project: resolved,
            agent: "claude",
            status: "active",
        });
        if (sessions.length === 0)
            return undefined;
        const live = sessions.filter((sess) => sess.lease_holder_connection_id != null);
        const pool = live.length > 0 ? live : sessions;
        const match = conversation
            ? resolveSessionForConversation(pool, conversation, (sess) => sess.session_id)
            : pool[0];
        const latest = match ?? pool[0];
        if (!latest)
            return undefined;
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
    async hydrateRegistrationForSession(session) {
        if (!this.storage)
            return undefined;
        const record = await this.storage.getSession(session);
        if (!record || record.agent !== "claude")
            return undefined;
        return this.register({
            session,
            project: record.project,
            account_label_scope: record.account_label_scope,
        });
    }
}
//# sourceMappingURL=wake.js.map