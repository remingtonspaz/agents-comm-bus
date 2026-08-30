import type {
  AccountRegistration,
  AgentId,
  AccountId,
  CommId,
  Session,
  Storage,
} from "agents-comm-bus-core";

import type { MessageBus } from "../bus.js";
import { normalizeProjectPath } from "../project-path.js";
import { filterRegistrationsByScope } from "../session-label-scope.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommLeaseArbiter } from "./comm-lease.js";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
import { adapterMapKey, type removeLiveAdapter } from "./comm-adapter-lifecycle.js";

/** Grace before lazy adapters are stopped when a scope has zero live sessions. */
export const DEFAULT_SCOPE_RELEASE_GRACE_MS = 30_000;

export interface ScopeReleaseReconcileCounts {
  scopes_zero_live: number;
  scopes_released: number;
  adapters_removed: number;
  active_scopes_pruned: number;
}

export interface ScopeReleaseReconcileState {
  zeroLiveSince: Map<string, number>;
}

export function scopeKey(
  agent: AgentId | string,
  project: string,
  accountLabelScope?: string | null,
): string {
  return `${agent}:${normalizeProjectPath(project)}:${accountLabelScope ?? ""}`;
}

function isRegistrationScopeActive(
  registration: AccountRegistration,
  activeScopes: ReadonlySet<string>,
): boolean {
  const prefix = `${registration.agent}:${normalizeProjectPath(registration.project)}:`;
  const legacyKey = `${registration.agent}:${normalizeProjectPath(registration.project)}`;
  for (const key of activeScopes) {
    if (key === legacyKey) return true;
    if (!key.startsWith(prefix)) continue;
    const scopeStored = key.slice(prefix.length);
    const scope = scopeStored.length > 0 ? scopeStored : null;
    if (filterRegistrationsByScope([registration], scope).length > 0) return true;
  }
  return false;
}

function countLiveSessionsForScope(
  sessions: readonly Session[],
  key: string,
  sessionOwnerIsLive: SessionOwnerLiveness,
): number {
  let count = 0;
  for (const session of sessions) {
    if (session.status !== "active") continue;
    if (scopeKey(session.agent, session.project, session.account_label_scope) !== key) continue;
    if (!sessionOwnerIsLive(session)) continue;
    count += 1;
  }
  return count;
}

/**
 * AGE-101: reconcile lazy adapters when durable live-session truth shows zero
 * owners for an active scope. Reuses the reload removal path via removeLiveAdapter.
 */
export async function reconcileLazyAdapterScopes(input: {
  storage: Storage;
  bus: MessageBus;
  bridges: AgentBridge[];
  factories: CommAdapterFactory[];
  activeScopes: Set<string>;
  leaseArbiter: CommLeaseArbiter;
  sessionOwnerIsLive: SessionOwnerLiveness;
  removeAdapter: typeof removeLiveAdapter;
  state: ScopeReleaseReconcileState;
  graceMs?: number;
  now?: () => number;
}): Promise<ScopeReleaseReconcileCounts> {
  const counts: ScopeReleaseReconcileCounts = {
    scopes_zero_live: 0,
    scopes_released: 0,
    adapters_removed: 0,
    active_scopes_pruned: 0,
  };
  const now = (input.now ?? Date.now)();
  const graceMs = input.graceMs ?? DEFAULT_SCOPE_RELEASE_GRACE_MS;
  const activeSessions = await input.storage.listSessions({ status: "active" });

  for (const key of [...input.activeScopes]) {
    const liveCount = countLiveSessionsForScope(
      activeSessions,
      key,
      input.sessionOwnerIsLive,
    );
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
    if (now - firstZero < graceMs) continue;

    const scopeSet = new Set<string>([key]);
    const lazyRegs: AccountRegistration[] = [];
    for (const factory of input.factories) {
      const regs = await input.storage.listAccountRegistrations({ comm: factory.commId });
      for (const reg of regs) {
        if (reg.activation === "eager") continue;
        if (!isRegistrationScopeActive(reg, scopeSet)) continue;
        lazyRegs.push(reg);
      }
    }

    let removedAny = false;
    for (const reg of lazyRegs) {
      const commId = reg.comm as CommId;
      const accountId = reg.bot_user_id as AccountId;
      if (!input.bus.getComm(commId, accountId)) continue;
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

export function liveAdapterKeys(bus: MessageBus): Set<string> {
  const keys = new Set<string>();
  for (const entry of bus.listComms()) {
    keys.add(adapterMapKey(entry.commId, entry.accountId));
  }
  return keys;
}
