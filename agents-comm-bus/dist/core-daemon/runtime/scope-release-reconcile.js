import { normalizeProjectPath } from "../project-path.js";
import { filterRegistrationsByScope } from "../session-label-scope.js";
import { adapterMapKey } from "./comm-adapter-lifecycle.js";
/** Grace before lazy adapters are stopped when a scope has zero live sessions. */
export const DEFAULT_SCOPE_RELEASE_GRACE_MS = 30_000;
export function scopeKey(agent, project, accountLabelScope) {
    return `${agent}:${normalizeProjectPath(project)}:${accountLabelScope ?? ""}`;
}
function isRegistrationScopeActive(registration, activeScopes) {
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
function countLiveSessionsForScope(sessions, key, sessionOwnerIsLive) {
    let count = 0;
    for (const session of sessions) {
        if (session.status !== "active")
            continue;
        if (scopeKey(session.agent, session.project, session.account_label_scope) !== key)
            continue;
        if (!sessionOwnerIsLive(session))
            continue;
        count += 1;
    }
    return count;
}
/**
 * AGE-101: reconcile lazy adapters when durable live-session truth shows zero
 * owners for an active scope. Reuses the reload removal path via removeLiveAdapter.
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
    for (const key of [...input.activeScopes]) {
        const liveCount = countLiveSessionsForScope(activeSessions, key, input.sessionOwnerIsLive);
        if (liveCount > 0) {
            input.state.zeroLiveSince.delete(key);
            continue;
        }
        counts.scopes_zero_live += 1;
        const firstZero = input.state.zeroLiveSince.get(key);
        if (firstZero == null) {
            input.state.zeroLiveSince.set(key, now);
            continue;
        }
        if (now - firstZero < graceMs)
            continue;
        const scopeSet = new Set([key]);
        const lazyRegs = [];
        for (const factory of input.factories) {
            const regs = await input.storage.listAccountRegistrations({ comm: factory.commId });
            for (const reg of regs) {
                if (reg.activation === "eager")
                    continue;
                if (!isRegistrationScopeActive(reg, scopeSet))
                    continue;
                lazyRegs.push(reg);
            }
        }
        let removedAny = false;
        for (const reg of lazyRegs) {
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
            removedAny = true;
        }
        if (removedAny || lazyRegs.length === 0) {
            counts.scopes_released += 1;
            input.state.zeroLiveSince.delete(key);
            if (input.activeScopes.delete(key)) {
                counts.active_scopes_pruned += 1;
            }
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