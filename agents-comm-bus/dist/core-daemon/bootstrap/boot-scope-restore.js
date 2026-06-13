import { access } from "node:fs/promises";
import { join } from "node:path";
import { normalizeProjectPath } from "../project-path.js";
import { normalizeDaemonRootPath } from "../paths.js";
/** Default recency window for boot-time scope restore (24 hours). */
export const DEFAULT_BOOT_RESTORE_RECENCY_MS = 24 * 60 * 60 * 1000;
function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function defaultPathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
function scopeDedupeKey(agent, project) {
    return `${agent}:${normalizeProjectPath(project)}`;
}
function classifySessionDaemonOwner(session, currentDiscoveryRoot) {
    const stamped = session.lease_owner_daemon_discovery_root;
    if (stamped == null || stamped.length === 0)
        return "missing";
    return normalizeDaemonRootPath(stamped) === normalizeDaemonRootPath(currentDiscoveryRoot)
        ? "match"
        : "foreign";
}
async function auditBootRestore(audit, timestamp, summary, error) {
    if (!audit)
        return;
    const detail = { ...summary };
    if (error !== undefined) {
        detail.error = error instanceof Error ? error.message : String(error);
    }
    await audit
        .append({
        timestamp,
        kind: "daemon_boot_restore",
        detail,
    })
        .catch(() => { });
}
/**
 * AGE-55: on daemon boot, re-ensure comm scopes whose host owner process is
 * still alive. Best-effort and idempotent — never throws to the caller.
 */
export async function runBootScopeRestore(input) {
    const now = input.now ?? (() => Date.now());
    const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
    const recencyMs = input.recencyMs ?? DEFAULT_BOOT_RESTORE_RECENCY_MS;
    const pathExists = input.pathExists ?? defaultPathExists;
    const summary = {
        status: "completed",
        candidates: 0,
        restored: 0,
        skipped_dead: 0,
        skipped_stale: 0,
        skipped_no_owner: 0,
        skipped_no_daemon_owner: 0,
        skipped_foreign_owner: 0,
    };
    try {
        const pausedPath = join(input.stateRoot, "paused");
        if (await pathExists(pausedPath)) {
            summary.status = "skipped_paused";
            console.error("agents-comm-bus: boot scope restore skipped (paused marker present)");
            await auditBootRestore(input.audit, now(), summary);
            return summary;
        }
        const sessions = await input.storage.listSessions({ status: "active" });
        summary.candidates = sessions.length;
        const scopesToRestore = new Map();
        for (const session of sessions) {
            const pid = session.lease_owner_process_pid;
            const registeredAt = session.lease_owner_process_registered_at;
            if (pid == null || registeredAt == null) {
                summary.skipped_no_owner += 1;
                continue;
            }
            if (now() - registeredAt > recencyMs) {
                summary.skipped_stale += 1;
                continue;
            }
            if (!isPidAlive(pid)) {
                summary.skipped_dead += 1;
                continue;
            }
            const ownerClass = classifySessionDaemonOwner(session, input.discoveryRoot);
            if (ownerClass === "missing") {
                summary.skipped_no_daemon_owner += 1;
                continue;
            }
            if (ownerClass === "foreign") {
                summary.skipped_foreign_owner += 1;
                continue;
            }
            // TODO(AGE-55): compare process start time against registeredAt to detect
            // pid reuse within the recency window. No clean cross-platform API from
            // Node built-ins — accepted-narrow v1 residual; worst case re-ensures an
            // idempotent comm adapter for a defunct session (recoverable, not destructive).
            const canonicalProject = normalizeProjectPath(session.project);
            const key = scopeDedupeKey(session.agent, canonicalProject);
            if (!scopesToRestore.has(key)) {
                scopesToRestore.set(key, { project: canonicalProject, agent: session.agent });
            }
        }
        for (const scope of scopesToRestore.values()) {
            try {
                await input.ensureCommsForSession(scope.project, scope.agent);
                summary.restored += 1;
            }
            catch (error) {
                console.error(`agents-comm-bus: boot scope restore ensure failed for ` +
                    `${scope.project}/${scope.agent}: ` +
                    `${error instanceof Error ? error.message : String(error)}`);
            }
        }
        console.error("agents-comm-bus: boot scope restore complete: " +
            `candidates=${summary.candidates} restored=${summary.restored} ` +
            `skipped_dead=${summary.skipped_dead} skipped_stale=${summary.skipped_stale} ` +
            `skipped_no_owner=${summary.skipped_no_owner} ` +
            `skipped_no_daemon_owner=${summary.skipped_no_daemon_owner} ` +
            `skipped_foreign_owner=${summary.skipped_foreign_owner}`);
        await auditBootRestore(input.audit, now(), summary);
        return summary;
    }
    catch (error) {
        console.error("agents-comm-bus: boot scope restore failed: " +
            `${error instanceof Error ? error.message : String(error)}`);
        await auditBootRestore(input.audit, now(), summary, error);
        return summary;
    }
}
//# sourceMappingURL=boot-scope-restore.js.map