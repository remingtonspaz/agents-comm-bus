import { normalizeProjectPath } from "../project-path.js";
import { normalizeDaemonRootPath } from "../paths.js";
import { filterRegistrationsByScope } from "../session-label-scope.js";
import { adapterMapKey } from "./comm-adapter-lifecycle.js";
/** Grace before lazy adapters are stopped when a scope has zero live sessions. */
export const DEFAULT_SCOPE_RELEASE_GRACE_MS = 30_000;
export function scopeKey(agent, project, accountLabelScope) {
    return `${agent}:${normalizeProjectPath(project)}:${accountLabelScope ?? ""}`;
}
export function isRegistrationScopeActive(registration, activeScopes) {
    const prefix = `${registration.agent}:${normalizeProjectPath(registration.project)}:`;
    const legacyKey = `${registration.agent}:${normalizeProjectPath(registration.project)}`;
    for (const key of activeScopes) {
        if (key === legacyKey)
            return true;
        if (!key.startsWith(prefix))
            continue;
        const scopeStored = key.slice(prefix.length);
        const scope = scopeStored.length > 0 ? scopeStored : null;
        if (filterRegistrationsByScope([registration], scope).length > 0)
            return true;
    }
    return false;
}
/**
 * Whether an active session counts as a live LOCAL owner for scope release.
 * Missing daemon-owner stamps are treated conservatively as local (retain adapter)
 * so a row whose stamp lands moments after register is not over-released.
 */
function isSessionLocalLiveOwner(session, discoveryRoot, sessionOwnerIsLive) {
    if (session.status !== "active")
        return false;
    if (!sessionOwnerIsLive(session))
        return false;
    const stamped = session.lease_owner_daemon_discovery_root;
    if (stamped == null || stamped.length === 0)
        return true;
    return (normalizeDaemonRootPath(stamped) === normalizeDaemonRootPath(discoveryRoot));
}
function countLocalLiveSessionsForScope(sessions, key, discoveryRoot, sessionOwnerIsLive) {
    let count = 0;
    for (const session of sessions) {
        if (scopeKey(session.agent, session.project, session.account_label_scope) !== key) {
            continue;
        }
        if (!isSessionLocalLiveOwner(session, discoveryRoot, sessionOwnerIsLive))
            continue;
        count += 1;
    }
    return count;
}
async function listAllRegistrations(storage, factories) {
    const all = [];
    for (const factory of factories) {
        const regs = await storage.listAccountRegistrations({ comm: factory.commId });
        all.push(...regs);
    }
    return all;
}
/**
 * Union of lazy+eager registrations desired by every live LOCAL session scope
 * plus all eager standing registrations.
 */
export async function buildGlobalDesiredRegistrationIds(input) {
    const allRegistrations = input.allRegistrations ?? await listAllRegistrations(input.storage, input.factories);
    const activeSessions = input.activeSessions ??
        (await input.storage.listSessions({ status: "active" }));
    const desired = new Set();
    for (const reg of allRegistrations) {
        if (reg.activation === "eager") {
            desired.add(reg.registration_id);
        }
    }
    for (const session of activeSessions) {
        if (!isSessionLocalLiveOwner(session, input.discoveryRoot, input.sessionOwnerIsLive)) {
            continue;
        }
        const projectRegs = allRegistrations.filter((reg) => reg.agent === session.agent &&
            normalizeProjectPath(reg.project) === normalizeProjectPath(session.project));
        const scoped = filterRegistrationsByScope(projectRegs, session.account_label_scope);
        for (const reg of scoped) {
            desired.add(reg.registration_id);
        }
    }
    return desired;
}
/**
 * AGE-101: reconcile lazy adapters when durable live-session truth shows zero
 * local owners for an active scope. Reuses the reload removal path via removeLiveAdapter.
 */
export async function reconcileLazyAdapterScopes(input) {
    const counts = {
        scopes_zero_live: 0,
        scopes_released: 0,
        adapters_removed: 0,
        active_scopes_pruned: 0,
    };
    const now = (input.now ?? Date.now)();
    const graceMs = input.graceMs ?? DEFAULT_SCOPE_RELEASE_GRACE_MS;
    const activeSessions = await input.storage.listSessions({ status: "active" });
    const allRegistrations = await listAllRegistrations(input.storage, input.factories);
    const scopesReady = new Set();
    for (const key of [...input.activeScopes]) {
        const liveCount = countLocalLiveSessionsForScope(activeSessions, key, input.discoveryRoot, input.sessionOwnerIsLive);
        if (liveCount > 0) {
            input.state.zeroLiveSince.delete(key);
            input.cancelGraceExpiry?.(key);
            continue;
        }
        counts.scopes_zero_live += 1;
        if (graceMs === 0) {
            scopesReady.add(key);
            input.state.zeroLiveSince.delete(key);
            input.cancelGraceExpiry?.(key);
            continue;
        }
        const firstZero = input.state.zeroLiveSince.get(key);
        if (firstZero == null) {
            input.state.zeroLiveSince.set(key, now);
            input.scheduleGraceExpiry?.(key, graceMs);
            continue;
        }
        if (now - firstZero < graceMs)
            continue;
        scopesReady.add(key);
        input.state.zeroLiveSince.delete(key);
        input.cancelGraceExpiry?.(key);
    }
    if (scopesReady.size === 0)
        return counts;
    const desiredRegistrationIds = await buildGlobalDesiredRegistrationIds({
        storage: input.storage,
        factories: input.factories,
        discoveryRoot: input.discoveryRoot,
        sessionOwnerIsLive: input.sessionOwnerIsLive,
        allRegistrations,
        activeSessions,
    });
    const lazyRegs = allRegistrations.filter((reg) => reg.activation !== "eager");
    for (const reg of lazyRegs) {
        if (desiredRegistrationIds.has(reg.registration_id))
            continue;
        if (!isRegistrationScopeActive(reg, scopesReady))
            continue;
        const commId = reg.comm;
        const accountId = reg.bot_user_id;
        if (!input.bus.getComm(commId, accountId))
            continue;
        await input.removeAdapter({
            bus: input.bus,
            bridges: input.bridges,
            leaseArbiter: input.leaseArbiter,
            commId,
            accountId,
        });
        counts.adapters_removed += 1;
    }
    for (const key of scopesReady) {
        counts.scopes_released += 1;
        if (input.activeScopes.delete(key)) {
            counts.active_scopes_pruned += 1;
        }
    }
    return counts;
}
export function liveAdapterKeys(bus) {
    const keys = new Set();
    for (const entry of bus.listComms()) {
        keys.add(adapterMapKey(entry.commId, entry.accountId));
    }
    return keys;
}
//# sourceMappingURL=scope-release-reconcile.js.map