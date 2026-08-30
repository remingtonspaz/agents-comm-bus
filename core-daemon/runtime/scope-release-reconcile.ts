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
import { normalizeDaemonRootPath } from "../paths.js";
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
  graceTimers?: Map<string, unknown>;
}

export function scopeKey(
  agent: AgentId | string,
  project: string,
  accountLabelScope?: string | null,
): string {
  return `${agent}:${normalizeProjectPath(project)}:${accountLabelScope ?? ""}`;
}

export function isRegistrationScopeActive(
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

/**
 * Whether an active session counts as a live LOCAL owner for scope release.
 * Missing daemon-owner stamps are treated conservatively as local (retain adapter)
 * so a row whose stamp lands moments after register is not over-released.
 */
function isSessionLocalLiveOwner(
  session: Session,
  discoveryRoot: string,
  sessionOwnerIsLive: SessionOwnerLiveness,
): boolean {
  if (session.status !== "active") return false;
  if (!sessionOwnerIsLive(session)) return false;
  const stamped = session.lease_owner_daemon_discovery_root;
  if (stamped == null || stamped.length === 0) return true;
  return (
    normalizeDaemonRootPath(stamped) === normalizeDaemonRootPath(discoveryRoot)
  );
}

function countLocalLiveSessionsForScope(
  sessions: readonly Session[],
  key: string,
  discoveryRoot: string,
  sessionOwnerIsLive: SessionOwnerLiveness,
): number {
  let count = 0;
  for (const session of sessions) {
    if (scopeKey(session.agent, session.project, session.account_label_scope) !== key) {
      continue;
    }
    if (!isSessionLocalLiveOwner(session, discoveryRoot, sessionOwnerIsLive)) continue;
    count += 1;
  }
  return count;
}

async function listAllRegistrations(
  storage: Storage,
  factories: CommAdapterFactory[],
): Promise<AccountRegistration[]> {
  const all: AccountRegistration[] = [];
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
async function buildGlobalDesiredRegistrationIds(input: {
  storage: Storage;
  factories: CommAdapterFactory[];
  discoveryRoot: string;
  sessionOwnerIsLive: SessionOwnerLiveness;
  allRegistrations?: AccountRegistration[];
  activeSessions?: readonly Session[];
}): Promise<Set<string>> {
  const allRegistrations =
    input.allRegistrations ?? await listAllRegistrations(input.storage, input.factories);
  const activeSessions =
    input.activeSessions ??
    (await input.storage.listSessions({ status: "active" }));

  const desired = new Set<string>();
  for (const reg of allRegistrations) {
    if (reg.activation === "eager") {
      desired.add(reg.registration_id);
    }
  }

  for (const session of activeSessions) {
    if (
      !isSessionLocalLiveOwner(
        session,
        input.discoveryRoot,
        input.sessionOwnerIsLive,
      )
    ) {
      continue;
    }
    const projectRegs = allRegistrations.filter(
      (reg) =>
        reg.agent === session.agent &&
        normalizeProjectPath(reg.project) === normalizeProjectPath(session.project),
    );
    const scoped = filterRegistrationsByScope(
      projectRegs,
      session.account_label_scope,
    );
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
  discoveryRoot: string;
  graceMs?: number;
  now?: () => number;
  scheduleGraceExpiry?: (key: string, delayMs: number) => void;
  cancelGraceExpiry?: (key: string) => void;
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
  const allRegistrations = await listAllRegistrations(input.storage, input.factories);
  const scopesReady = new Set<string>();

  for (const key of [...input.activeScopes]) {
    const liveCount = countLocalLiveSessionsForScope(
      activeSessions,
      key,
      input.discoveryRoot,
      input.sessionOwnerIsLive,
    );
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
    if (now - firstZero < graceMs) continue;

    scopesReady.add(key);
    input.state.zeroLiveSince.delete(key);
    input.cancelGraceExpiry?.(key);
  }

  if (scopesReady.size === 0) return counts;

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
    if (desiredRegistrationIds.has(reg.registration_id)) continue;
    if (!isRegistrationScopeActive(reg, scopesReady)) continue;

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
  }

  for (const key of scopesReady) {
    counts.scopes_released += 1;
    if (input.activeScopes.delete(key)) {
      counts.active_scopes_pruned += 1;
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
