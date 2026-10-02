import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProjectPath } from "../../project-path.js";
import { parseAccountLabelScope, resolveSessionForConversation, serializeAccountLabelScope, } from "../../session-label-scope.js";
import { createSessionOwnerLiveness, } from "../../runtime/session-owner-liveness.js";
import { selectActiveSessionForInboundWake } from "../../runtime/wake-target-selection.js";
export function hashProjectKey(projectPath) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < projectPath.length; i += 1) {
        hash ^= projectPath.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
export function claudeWakeDirForProject(projectPath, homeDir = os.homedir(), accountLabelScope = null) {
    const canonical = normalizeProjectPath(projectPath);
    const basename = path.basename(canonical) || "project";
    const legacyDir = `${basename}-${hashProjectKey(canonical)}`;
    let canonicalScope;
    try {
        canonicalScope = serializeAccountLabelScope(parseAccountLabelScope(accountLabelScope));
    }
    catch (error) {
        console.error("agents-comm-bus: invalid persisted Claude account_label_scope; " +
            "using a scope-inert wake directory: " +
            `${error instanceof Error ? error.message : String(error)}`);
        // Never collapse a corrupt non-null scope onto the legacy catch-all dir.
        canonicalScope = `__invalid__:${accountLabelScope}`;
    }
    return path.join(homeDir, ".agents-comm-bus", "claude-wake", "sessions", canonicalScope
        ? `${legacyDir}-${crypto.createHash("sha256").update(canonicalScope).digest("hex").slice(0, 12)}`
        : legacyDir);
}
export async function writeClaudeWakeTrigger(wakeDir, now = Date.now) {
    await mkdir(wakeDir, { recursive: true });
    await writeFile(path.join(wakeDir, "trigger-enter"), `${now()}\n`, "utf8");
}
export { WAKE_SEED_MAX_CHARS, buildWakeSeed, sanitizeWakeSeed, } from "../../runtime/wake-seed.js";
import { buildWakeSeed } from "../../runtime/wake-seed.js";
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
    sessionOwnerIsLive;
    registrations = new Map();
    storage = null;
    constructor(now = Date.now, sessionOwnerIsLive = createSessionOwnerLiveness()) {
        this.now = now;
        this.sessionOwnerIsLive = sessionOwnerIsLive;
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
            wakeDir: input.wakeDir ??
                claudeWakeDirForProject(project, os.homedir(), input.account_label_scope ?? null),
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
    registerFromSession(session) {
        return this.register({
            session: session.session_id,
            project: session.project,
            account_label_scope: session.account_label_scope,
        });
    }
    async resolveRegistrationForInbound(conversation, _message) {
        if (conversation.agent !== "claude")
            return null;
        if (!this.storage)
            return null;
        const session = await selectActiveSessionForInboundWake(this.storage, conversation.project, "claude", conversation, this.sessionOwnerIsLive);
        if (!session)
            return null;
        const registration = this.getForSession(session.session_id) ?? this.registerFromSession(session);
        return { registration, session };
    }
    async wakeConversation(conversation, message) {
        if (conversation.agent !== "claude")
            return false;
        if (!this.storage) {
            const registration = this.latestForProject(conversation.project, conversation);
            if (!registration)
                return false;
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
                    /* best-effort */
                }
            }
            await writeClaudeWakeTrigger(registration.wakeDir, this.now);
            return true;
        }
        const session = await selectActiveSessionForInboundWake(this.storage, conversation.project, "claude", conversation, this.sessionOwnerIsLive);
        if (!session)
            return false;
        const registration = this.getForSession(session.session_id) ?? this.registerFromSession(session);
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
     * is deterministic from persisted project + label scope, so reconstruction
     * is lossless even across daemon restarts.
     */
    async hydrateLatestForProject(project, conversation) {
        if (!this.storage)
            return undefined;
        const session = await selectActiveSessionForInboundWake(this.storage, project, "claude", conversation, this.sessionOwnerIsLive);
        if (!session)
            return undefined;
        return this.registerFromSession(session);
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