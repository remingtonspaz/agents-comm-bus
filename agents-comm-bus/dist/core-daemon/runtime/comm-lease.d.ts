import type { CommAdapter } from "agents-comm-bus-core";
/**
 * AGE-35: single-consumer comm-resource ownership lease.
 *
 * A stray daemon launched from another git checkout / worktree must not be able
 * to poll the same Telegram bot as the canonical daemon — two `getUpdates`
 * consumers race to a 409 Conflict and inbound silently dies. This module adds a
 * cross-checkout ownership lease keyed by `(comm_id, resource_id)` (for Telegram,
 * the resource is the bot_user_id). The lease lives at a FIXED os.homedir()-anchored
 * path — NOT under the overridable state root — so every daemon on the user
 * account, regardless of its `AGENTS_COMM_BUS_ROOT` / state root, contends on the
 * same lock file. The daemon arbitrates; the adapter merely declares its resource
 * (`exclusiveResource()`) and is gated behind the lease by {@link wrapWithLease}.
 */
/** Default window after which a holder whose `renewedAt` is older is considered stale. */
export declare const DEFAULT_STALENESS_MS = 90000;
/**
 * Margin (ms) by which a same-rank contender's `lastIpcServedAt` must exceed the
 * holder's for the contender to be considered "clearly fresher" and supersede.
 * Without a margin, normal clock jitter would let two equally-active daemons
 * flap the lease back and forth.
 */
export declare const DEFAULT_IPC_RECENCY_MARGIN_MS = 30000;
/**
 * Authority rank. A daemon's rank dominates every contention decision; recency
 * (`lastIpcServedAt`) is only a tiebreaker WITHIN a rank tier (or to confirm a
 * dead/stale holder), never across tiers. Ordering: main-dev > production >
 * worktree. A fresh low-rank contender must never beat a quiet higher-rank holder.
 */
export type AuthorityRank = "main-dev" | "production" | "worktree";
export declare const AUTHORITY_RANK_ORDER: Record<AuthorityRank, number>;
export interface LeaseRecord {
    comm_id: string;
    resource_id: string;
    pid: number;
    stateRoot: string;
    checkoutRoot: string | null;
    daemonBin: string | null;
    daemonVersion: string;
    authorityRank: AuthorityRank;
    acquiredAt: number;
    renewedAt: number;
    lastIpcServedAt: number;
}
export interface SelfIdentity {
    pid: number;
    stateRoot: string;
    checkoutRoot: string | null;
    daemonBin: string | null;
    daemonVersion: string;
    authorityRank: AuthorityRank;
}
export type AcquireResult = {
    ok: true;
    record: LeaseRecord;
} | {
    ok: false;
    reason: AcquireDenyReason;
    holder: LeaseRecord;
};
export type AcquireDenyReason = "held-by-higher-rank" | "held-by-same-rank-fresh" | "guard-contended";
export type RenewResult = {
    ok: true;
    record: LeaseRecord;
} | {
    ok: false;
    reason: "lost";
    holder: LeaseRecord | null;
};
/**
 * FIXED, homedir-anchored lease path. Deliberately bypasses resolveStatePaths /
 * AGENTS_COMM_BUS_ROOT: the whole point is that every checkout and every state
 * root shares ONE lock file per `(comm, resource)`.
 *
 * `homeDir` is injectable so tests never touch the real `~`.
 */
export declare function commLeasePath(commId: string, resourceId: string, homeDir?: string): string;
export interface RankInferenceInput {
    env: NodeJS.ProcessEnv;
    daemonBin: string | null;
    cwd: string;
    homeDir?: string;
    /** Injectable fs probes so the inference is pure + testable. */
    fileExists?: (p: string) => boolean;
    isDirectory?: (p: string) => boolean;
}
export interface RankInference {
    authorityRank: AuthorityRank;
    checkoutRoot: string | null;
}
/**
 * Infer the authority rank + checkout root from env + filesystem topology.
 *
 *  - If `AGENTS_COMM_BUS_BIN` resolves under `~/.${DAEMON_NAME}/bin/` (central
 *    install) → "production".
 *  - Else dev mode: walk up from the bin's dir (or cwd) to the directory that
 *    contains `.git`. If `.git` is a DIRECTORY → "main-dev"; if `.git` is a FILE
 *    (git worktree) → "worktree".
 *  - Undeterminable → "worktree" (lowest, safest: a daemon that can't prove it is
 *    the canonical dev/production install must not be able to steal the lease).
 */
export declare function inferAuthorityRank(input: RankInferenceInput): RankInference;
export interface DecisionInput {
    self: SelfIdentity;
    selfLastIpcServedAt: number;
    existing: LeaseRecord | null;
    now: number;
    isPidAlive: (pid: number) => boolean;
    stalenessMs: number;
    ipcRecencyMarginMs: number;
}
export type Decision = {
    take: true;
    reason: DecisionTakeReason;
} | {
    take: false;
    reason: AcquireDenyReason;
    holder: LeaseRecord;
};
export type DecisionTakeReason = "no-holder" | "holder-dead" | "holder-stale" | "higher-rank" | "same-rank-staler-holder";
/**
 * The contention decision. C = self/contender, H = current holder.
 *
 * Decision table (evaluated top-down):
 *  1. No record, OR H.pid dead, OR H stale (renewedAt older than stalenessMs) → C acquires.
 *  2. rank(C) > rank(H) → C reclaims. [loud audit at the caller]
 *  3. rank(C) < rank(H) → DENIED.     [loud audit; return holder info]
 *  4. rank(C) == rank(H):
 *       - H clearly staler than C by lastIpcServedAt (H.lastIpcServedAt + margin
 *         < C.lastIpcServedAt) AND H liveness doesn't contradict (H pid alive but
 *         quiet is the case we MAY supersede) → C acquires.
 *       - else (both fresh / ambiguous) → DENIED.
 *
 * INVARIANTS (load-bearing):
 *  - rank DOMINATES. lastIpcServedAt recency is a tiebreaker ONLY within the same
 *    rank tier (or to confirm dead/stale), NEVER across tiers. A fresh low-rank
 *    contender must NOT beat a quiet higher-rank holder.
 *  - Never steal from a live same-or-higher-rank holder merely because it's quiet
 *    (the margin + "both fresh ⇒ DENIED" rule enforces this).
 */
export declare function decideContention(input: DecisionInput): Decision;
export interface CommLeaseArbiterOptions {
    self: SelfIdentity;
    /** Returns the daemon's most-recent IPC-served timestamp (ms). */
    lastIpcServedAt: () => number;
    /** Override the home directory (tests). */
    homeDir?: string;
    /** Injectable liveness probe (tests). */
    isPidAlive?: (pid: number) => boolean;
    /** Injectable clock (tests). */
    now?: () => number;
    /** Override the staleness window. */
    stalenessMs?: number;
    /** Override the same-rank recency margin. */
    ipcRecencyMarginMs?: number;
    /** Audit hook for loud reclaim/deny events. Best-effort; never throws. */
    onAudit?: (event: CommLeaseAuditEvent) => void;
}
export interface CommLeaseAuditEvent {
    kind: "comm_lease_acquired" | "comm_lease_reclaimed" | "comm_lease_denied" | "comm_lease_lost" | "comm_lease_released";
    comm_id: string;
    resource_id: string;
    detail: Record<string, unknown>;
}
export declare class CommLeaseArbiter {
    private readonly self;
    private readonly lastIpcServedAt;
    private readonly homeDir;
    private readonly isPidAlive;
    private readonly now;
    private readonly stalenessMs;
    private readonly ipcRecencyMarginMs;
    private readonly onAudit?;
    constructor(options: CommLeaseArbiterOptions);
    get authorityRank(): AuthorityRank;
    /**
     * Attempt to acquire (or reclaim) the lease for `(commId, resourceId)`. Reads
     * the existing record under a guard lock, applies {@link decideContention},
     * and writes the self record on a take. Returns a discriminated result.
     */
    tryAcquire(commId: string, resourceId: string): Promise<AcquireResult>;
    /**
     * Re-write `renewedAt` + `lastIpcServedAt` — but ONLY if the on-disk record's
     * pid is still self. If a higher/equal-rank daemon reclaimed the lease in the
     * meantime, the on-disk pid differs; renew reports "lost" so the wrapper can
     * stop the inner adapter.
     */
    renew(commId: string, resourceId: string): Promise<RenewResult>;
    /** Delete the lease file, but only if it is still self's. Best-effort. */
    release(commId: string, resourceId: string): Promise<void>;
    private leasePath;
    private buildRecord;
    private placeholderHolder;
    private readRecord;
    private writeRecord;
    /**
     * Guard lock that serializes the read-decide-write. Uses the spawn-lock idiom
     * (O_EXCL create) on `<resource>.json.guard`. If the guard exists but its owner
     * pid is dead, reclaim it (stale-guard reclaim) so a crashed acquirer can't
     * wedge the lease forever.
     */
    private acquireGuard;
    private guardIsStale;
    private releaseGuard;
    private audit;
}
export interface WrapWithLeaseOptions {
    /** Renewal interval while holding the lease (ms). */
    renewIntervalMs?: number;
    /** Slow re-acquire poll interval while denied (ms). */
    reacquireIntervalMs?: number;
    /** Injected timer factory (tests). Defaults to setInterval/clearInterval. */
    setIntervalFn?: (fn: () => void, ms: number) => unknown;
    clearIntervalFn?: (handle: unknown) => void;
    /** Loud logger. Defaults to console.error. */
    log?: (message: string) => void;
}
/**
 * Wrap an adapter so the daemon only starts it once it holds the
 * `(comm, resource)` ownership lease. The bus and the inner adapter stay
 * lease-unaware: this proxy delegates everything to `inner`, and only `start` /
 * `stop` carry lease logic.
 *
 *  - `start()`: if `inner.exclusiveResource()` is null → just `inner.start()`.
 *    Else tryAcquire. On success → `inner.start()` + a renewal timer; if a renew
 *    reports "lost" → stop the inner adapter, log loud, and begin a slow
 *    re-acquire poll. On denial → do NOT start inner; log loud; begin a slow
 *    re-acquire poll (back-off discipline; no tight loop) so it reclaims if the
 *    holder dies.
 *  - `stop()`: clear timers, `inner.stop()`, release the lease.
 */
export declare function wrapWithLease(inner: CommAdapter, arbiter: CommLeaseArbiter, options?: WrapWithLeaseOptions): CommAdapter;
//# sourceMappingURL=comm-lease.d.ts.map