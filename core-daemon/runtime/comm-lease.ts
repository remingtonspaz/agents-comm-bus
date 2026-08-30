import { constants, existsSync, statSync } from "node:fs";
import { open, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommAdapter } from "agents-comm-bus-core";

import { DAEMON_NAME } from "../config.js";
import { readProcessStartIdentity } from "./process-start-epoch.js";

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
export const DEFAULT_STALENESS_MS = 90_000;
/**
 * Margin (ms) by which a same-rank contender's `lastIpcServedAt` must exceed the
 * holder's for the contender to be considered "clearly fresher" and supersede.
 * Without a margin, normal clock jitter would let two equally-active daemons
 * flap the lease back and forth.
 *
 * INVARIANT (AGE-35 review): the holder's PERSISTED `lastIpcServedAt` is only
 * rewritten on renew (every DEFAULT_RENEW_INTERVAL_MS), so it lags the holder's
 * true IPC activity by up to one renew interval. The same-rank compare reads
 * that persisted value, so this margin MUST stay comfortably larger than the
 * renew interval (we keep margin >= 3x renew) — otherwise that lag could make an
 * actively-serving same-rank holder look stale enough to be superseded,
 * violating the "both active same-rank ⇒ deny, don't guess" invariant. See
 * {@link DEFAULT_RENEW_INTERVAL_MS}.
 */
export const DEFAULT_IPC_RECENCY_MARGIN_MS = 30_000;

/**
 * Authority rank. A daemon's rank dominates every contention decision; recency
 * (`lastIpcServedAt`) is only a tiebreaker WITHIN a rank tier (or to confirm a
 * dead/stale holder), never across tiers. Ordering: main-dev > production >
 * worktree. A fresh low-rank contender must never beat a quiet higher-rank holder.
 */
export type AuthorityRank = "main-dev" | "production" | "worktree";

export const AUTHORITY_RANK_ORDER: Record<AuthorityRank, number> = {
  "main-dev": 2,
  production: 1,
  worktree: 0,
};

/** Agent-neutral optional metadata stamped onto a comm-resource lease (AGE-100). */
export interface AgentLeaseProperties {
  codex?: {
    appServerUrl: string;
    threadId: string;
  };
}

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
  /** Optional per-agent wake/control metadata; omitted on legacy lease files. */
  agentProperties?: AgentLeaseProperties;
  /** Process creation epoch (ms); stamped at acquire/renew for AGE-102 liveness. */
  process_start_time?: number;
}

export interface SelfIdentity {
  pid: number;
  stateRoot: string;
  checkoutRoot: string | null;
  daemonBin: string | null;
  daemonVersion: string;
  authorityRank: AuthorityRank;
}

export type AcquireResult =
  | { ok: true; record: LeaseRecord }
  | { ok: false; reason: AcquireDenyReason; holder: LeaseRecord };

export type AcquireDenyReason =
  | "held-by-higher-rank"
  | "held-by-same-rank-fresh"
  | "not-eligible-for-scope"
  | "guard-contended";

export type RenewResult =
  | { ok: true; record: LeaseRecord }
  | { ok: false; reason: "lost"; holder: LeaseRecord | null };

/** Read-only snapshot of a comm-resource lease held by this daemon (AGE-100). */
export type HeldCommLeaseLookupResult =
  | {
      ok: true;
      comm_id: string;
      resource_id: string;
      agentProperties?: AgentLeaseProperties;
    }
  | {
      ok: false;
      reason: "missing-record" | "unreadable" | "not-held-by-self";
    };

export type ReadHeldCommLease = (
  commId: string,
  resourceId: string,
) => Promise<HeldCommLeaseLookupResult>;

// ---------------------------------------------------------------------------
// Pure helpers (path + rank inference) — unit-testable, no I/O of their own.
// ---------------------------------------------------------------------------

/**
 * FIXED, homedir-anchored lease path. Deliberately bypasses resolveStatePaths /
 * AGENTS_COMM_BUS_ROOT: the whole point is that every checkout and every state
 * root shares ONE lock file per `(comm, resource)`.
 *
 * `homeDir` is injectable so tests never touch the real `~`.
 */
export function commLeasePath(
  commId: string,
  resourceId: string,
  homeDir: string = os.homedir(),
): string {
  return path.join(
    homeDir,
    `.${DAEMON_NAME}`,
    "comm-locks",
    safeSegment(commId),
    `${safeSegment(resourceId)}.json`,
  );
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

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
export function inferAuthorityRank(input: RankInferenceInput): RankInference {
  const homeDir = input.homeDir ?? os.homedir();
  const fileExists = input.fileExists ?? defaultFileExists;
  const isDirectory = input.isDirectory ?? defaultIsDirectory;

  const bin = input.daemonBin ? path.resolve(input.daemonBin) : null;

  // Central-install detection: the bin lives under ~/.agents-comm-bus/bin/.
  if (bin) {
    const centralBinDir = path.resolve(path.join(homeDir, `.${DAEMON_NAME}`, "bin"));
    if (isUnder(bin, centralBinDir)) {
      return { authorityRank: "production", checkoutRoot: path.dirname(bin) };
    }
  }

  // Dev mode: find the checkout root (dir holding .git) walking up from the bin
  // directory, falling back to cwd.
  const startDirs = [bin ? path.dirname(bin) : null, path.resolve(input.cwd)].filter(
    (d): d is string => d !== null,
  );
  for (const start of startDirs) {
    const found = findGitRoot(start, fileExists);
    if (found) {
      const gitPath = path.join(found, ".git");
      const rank: AuthorityRank = isDirectory(gitPath) ? "main-dev" : "worktree";
      return { authorityRank: rank, checkoutRoot: found };
    }
  }

  // Undeterminable → lowest rank, safest.
  return { authorityRank: "worktree", checkoutRoot: null };
}

function findGitRoot(start: string, fileExists: (p: string) => boolean): string | null {
  let current = path.resolve(start);
  // Bound the walk so a pathological path can't loop forever.
  for (let i = 0; i < 64; i += 1) {
    if (fileExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function defaultFileExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function defaultIsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Contention decision (PURE) — the crux. Given the self identity, an optional
// existing on-disk record, and the clocks/liveness, decide whether SELF may
// take / keep the lease. No I/O — the arbiter feeds it the read record.
// ---------------------------------------------------------------------------

export interface DecisionInput {
  commId: string;
  resourceId: string;
  self: SelfIdentity;
  selfLastIpcServedAt: number;
  existing: LeaseRecord | null;
  now: number;
  isPidAlive: (pid: number) => boolean;
  stalenessMs: number;
  ipcRecencyMarginMs: number;
  /** AGE-101: injected discovery-root/project eligibility; default true. */
  eligible?: boolean;
}

export type Decision =
  | { take: true; reason: DecisionTakeReason }
  | { take: false; reason: AcquireDenyReason; holder: LeaseRecord };

export type DecisionTakeReason =
  | "no-holder"
  | "holder-dead"
  | "holder-stale"
  | "higher-rank"
  | "same-rank-staler-holder";

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
export function decideContention(input: DecisionInput): Decision {
  const { self, existing, now, isPidAlive, stalenessMs } = input;

  // AGE-101: foreign/missing discovery-root ownership blocks acquire even when
  // rank would win — eligibility is computed outside this module and injected.
  if (input.eligible === false) {
    const holder =
      existing ??
      ineligiblePlaceholderHolder(input.commId, input.resourceId);
    return { take: false, reason: "not-eligible-for-scope", holder };
  }

  // 1. No holder, dead holder, or stale holder → take.
  if (!existing) return { take: true, reason: "no-holder" };
  if (!isPidAlive(existing.pid)) return { take: true, reason: "holder-dead" };
  if (now - existing.renewedAt > stalenessMs) return { take: true, reason: "holder-stale" };

  const selfRank = AUTHORITY_RANK_ORDER[self.authorityRank];
  const holderRank = AUTHORITY_RANK_ORDER[existing.authorityRank];

  // 2. Higher rank → reclaim.
  if (selfRank > holderRank) return { take: true, reason: "higher-rank" };

  // 3. Lower rank → denied. A fresh low-rank contender must NOT beat a quiet
  //    higher-rank holder.
  if (selfRank < holderRank) {
    return { take: false, reason: "held-by-higher-rank", holder: existing };
  }

  // 4. Same rank → recency tiebreaker, but only when the holder is CLEARLY staler
  //    by a margin. Both-fresh (or contender not clearly fresher) → DENIED
  //    (ambiguous; don't guess and risk a flap).
  const holderClearlyStaler =
    existing.lastIpcServedAt + input.ipcRecencyMarginMs < input.selfLastIpcServedAt;
  if (holderClearlyStaler) {
    return { take: true, reason: "same-rank-staler-holder" };
  }
  return { take: false, reason: "held-by-same-rank-fresh", holder: existing };
}

function ineligiblePlaceholderHolder(commId: string, resourceId: string): LeaseRecord {
  return {
    comm_id: commId,
    resource_id: resourceId,
    pid: -1,
    stateRoot: "",
    checkoutRoot: null,
    daemonBin: null,
    daemonVersion: "",
    authorityRank: "worktree",
    acquiredAt: 0,
    renewedAt: 0,
    lastIpcServedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Arbiter — does the I/O (guard lock, read-decide-write, renew, release).
// ---------------------------------------------------------------------------

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
  /** AGE-102: native-only process-start stamp; null omits identity (tests inject). */
  readProcessStartIdentity?: (pid: number) => number | null;
}

export interface CommLeaseAuditEvent {
  kind:
    | "comm_lease_acquired"
    | "comm_lease_reclaimed"
    | "comm_lease_denied"
    | "comm_lease_lost"
    | "comm_lease_released";
  comm_id: string;
  resource_id: string;
  detail: Record<string, unknown>;
}

export class CommLeaseArbiter {
  private readonly self: SelfIdentity;
  private readonly lastIpcServedAt: () => number;
  private readonly homeDir: string;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly stalenessMs: number;
  private readonly ipcRecencyMarginMs: number;
  private readonly onAudit?: (event: CommLeaseAuditEvent) => void;
  private readonly readProcessStartIdentity: (pid: number) => number | null;

  /**
   * Per-resource signature of the last `comm_lease_denied` we actually audited,
   * keyed by `${commId}:${resourceId}` → `${reason}:${holderPid}`. The slow
   * re-acquire poll ({@link wrapWithLease.startReacquireTimer}, every
   * DEFAULT_REACQUIRE_INTERVAL_MS) re-attempts a lease it cannot win forever
   * (`held-by-higher-rank` is a STABLE condition), so without dedup it writes an
   * identical denial row every poll — thousands/day per held bot. Audit is for
   * state TRANSITIONS: emit a denial only when it first occurs or when the
   * holder/reason changes, and reset on a successful take so the next genuine
   * denial logs again.
   */
  private readonly lastDenyAudit = new Map<string, string>();
  /** AGE-36: runtime-local inventory of leases this arbiter currently holds. */
  private readonly heldLeases = new Set<string>();
  /** Locally desired agent properties keyed by `${commId}:${resourceId}` (AGE-100). */
  private readonly desiredAgentProperties = new Map<string, AgentLeaseProperties>();

  constructor(options: CommLeaseArbiterOptions) {
    this.self = options.self;
    this.lastIpcServedAt = options.lastIpcServedAt;
    this.homeDir = options.homeDir ?? os.homedir();
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.now = options.now ?? Date.now;
    this.stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS;
    this.ipcRecencyMarginMs = options.ipcRecencyMarginMs ?? DEFAULT_IPC_RECENCY_MARGIN_MS;
    this.onAudit = options.onAudit;
    this.readProcessStartIdentity = options.readProcessStartIdentity ?? readProcessStartIdentity;
  }

  get authorityRank(): AuthorityRank {
    return this.self.authorityRank;
  }

  /** Count of `(comm, resource)` leases this arbiter currently owns. */
  heldLeaseCount(): number {
    return this.heldLeases.size;
  }

  /** Snapshot of held lease keys — for retirement eligibility and tests. */
  heldLeaseSnapshot(): ReadonlyArray<{ comm_id: string; resource_id: string }> {
    return [...this.heldLeases].map((key) => {
      const sep = key.indexOf(":");
      return {
        comm_id: key.slice(0, sep),
        resource_id: key.slice(sep + 1),
      };
    });
  }

  /**
   * Record daemon-local desired agent properties for a comm resource. The next
   * acquire/renew/sync stamps them onto the lease when this arbiter holds it.
   */
  setDesiredAgentProperties(
    commId: string,
    resourceId: string,
    agentProperties: AgentLeaseProperties,
  ): void {
    this.desiredAgentProperties.set(this.leaseKey(commId, resourceId), agentProperties);
  }

  desiredAgentPropertiesFor(commId: string, resourceId: string): AgentLeaseProperties | undefined {
    return this.desiredAgentProperties.get(this.leaseKey(commId, resourceId));
  }

  /**
   * Re-write `agentProperties` on an already-held lease from the desired map.
   * No-op when this arbiter does not currently hold the lease.
   */
  async syncAgentProperties(commId: string, resourceId: string): Promise<void> {
    const desired = this.desiredAgentProperties.get(this.leaseKey(commId, resourceId));
    if (!desired) return;
    const leasePath = this.leasePath(commId, resourceId);
    const guard = await this.acquireGuard(leasePath);
    if (!guard) return;
    try {
      const existing = await this.readRecord(leasePath);
      if (!existing || existing.pid !== this.self.pid) return;
      const updated: LeaseRecord = {
        ...existing,
        renewedAt: this.now(),
        lastIpcServedAt: this.lastIpcServedAt(),
        agentProperties: desired,
      };
      await this.writeRecord(leasePath, updated);
    } finally {
      await this.releaseGuard(leasePath, guard);
    }
  }

  /**
   * Read the on-disk comm-resource lease when this arbiter's pid is the holder.
   * Does not acquire or mutate the lease.
   */
  async readHeldCommLease(commId: string, resourceId: string): Promise<HeldCommLeaseLookupResult> {
    const key = this.leaseKey(commId, resourceId);
    if (!this.heldLeases.has(key)) {
      return { ok: false, reason: "not-held-by-self" };
    }

    const leasePath = this.leasePath(commId, resourceId);
    let exists = false;
    try {
      exists = existsSync(leasePath);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!exists) return { ok: false, reason: "missing-record" };

    const existing = await this.readRecord(leasePath);
    if (!existing) return { ok: false, reason: "unreadable" };
    if (existing.pid !== this.self.pid) return { ok: false, reason: "not-held-by-self" };
    return {
      ok: true,
      comm_id: commId,
      resource_id: resourceId,
      agentProperties: existing.agentProperties,
    };
  }

  /**
   * Attempt to acquire (or reclaim) the lease for `(commId, resourceId)`. Reads
   * the existing record under a guard lock, applies {@link decideContention},
   * and writes the self record on a take. Returns a discriminated result.
   */
  async tryAcquire(
    commId: string,
    resourceId: string,
    acquireOptions?: { eligible?: boolean },
  ): Promise<AcquireResult> {
    const leasePath = this.leasePath(commId, resourceId);
    const guard = await this.acquireGuard(leasePath);
    if (!guard) {
      // Could not serialize the read-decide-write. Treat as transient contention.
      const holder = (await this.readRecord(leasePath)) ?? this.placeholderHolder(commId, resourceId);
      return { ok: false, reason: "guard-contended", holder };
    }
    try {
      const existing = await this.readRecord(leasePath);
      const decision = decideContention({
        commId,
        resourceId,
        self: this.self,
        selfLastIpcServedAt: this.lastIpcServedAt(),
        existing,
        now: this.now(),
        isPidAlive: this.isPidAlive,
        stalenessMs: this.stalenessMs,
        ipcRecencyMarginMs: this.ipcRecencyMarginMs,
        eligible: acquireOptions?.eligible,
      });

      if (!decision.take) {
        // Dedup: only audit a denial on a state change (first denial of a streak,
        // or a changed holder/reason). A steady-state poll that keeps getting the
        // same answer is a non-event and must not flood the audit log.
        const denyKey = `${commId}:${resourceId}`;
        const denySig = `${decision.reason}:${decision.holder.pid}`;
        if (this.lastDenyAudit.get(denyKey) !== denySig) {
          this.lastDenyAudit.set(denyKey, denySig);
          this.audit({
            kind: "comm_lease_denied",
            comm_id: commId,
            resource_id: resourceId,
            detail: {
              reason: decision.reason,
              self_pid: this.self.pid,
              self_rank: this.self.authorityRank,
              holder_pid: decision.holder.pid,
              holder_rank: decision.holder.authorityRank,
              holder_checkout: decision.holder.checkoutRoot,
            },
          });
        }
        return { ok: false, reason: decision.reason, holder: decision.holder };
      }

      // Took the lease — clear any denial-streak signature so that if we later
      // lose it and get denied again, that fresh denial audits.
      this.lastDenyAudit.delete(`${commId}:${resourceId}`);
      const record = this.buildRecord(commId, resourceId, existing);
      await this.writeRecord(leasePath, record);

      const reclaimed = decision.reason === "higher-rank" || decision.reason === "same-rank-staler-holder";
      this.audit({
        kind: reclaimed ? "comm_lease_reclaimed" : "comm_lease_acquired",
        comm_id: commId,
        resource_id: resourceId,
        detail: {
          reason: decision.reason,
          self_pid: this.self.pid,
          self_rank: this.self.authorityRank,
          previous_holder_pid: existing?.pid ?? null,
          previous_holder_rank: existing?.authorityRank ?? null,
        },
      });
      this.heldLeases.add(this.leaseKey(commId, resourceId));
      return { ok: true, record };
    } finally {
      await this.releaseGuard(leasePath, guard);
    }
  }

  /**
   * Re-write `renewedAt` + `lastIpcServedAt` — but ONLY if the on-disk record's
   * pid is still self. If a higher/equal-rank daemon reclaimed the lease in the
   * meantime, the on-disk pid differs; renew reports "lost" so the wrapper can
   * stop the inner adapter.
   */
  async renew(commId: string, resourceId: string): Promise<RenewResult> {
    const leasePath = this.leasePath(commId, resourceId);
    const guard = await this.acquireGuard(leasePath);
    if (!guard) {
      // Couldn't serialize; do NOT assume lost — caller keeps the adapter up and
      // retries on the next renewal tick.
      const holder = await this.readRecord(leasePath);
      if (holder && holder.pid === this.self.pid) {
        return { ok: true, record: holder };
      }
      this.heldLeases.delete(this.leaseKey(commId, resourceId));
      return { ok: false, reason: "lost", holder };
    }
    try {
      const existing = await this.readRecord(leasePath);
      if (!existing || existing.pid !== this.self.pid) {
        this.heldLeases.delete(this.leaseKey(commId, resourceId));
        this.audit({
          kind: "comm_lease_lost",
          comm_id: commId,
          resource_id: resourceId,
          detail: {
            self_pid: this.self.pid,
            on_disk_pid: existing?.pid ?? null,
            on_disk_rank: existing?.authorityRank ?? null,
          },
        });
        return { ok: false, reason: "lost", holder: existing };
      }
      const renewed: LeaseRecord = {
        ...existing,
        renewedAt: this.now(),
        lastIpcServedAt: this.lastIpcServedAt(),
        process_start_time: this.processStartTimeForRecord(existing),
        agentProperties: this.agentPropertiesForRecord(commId, resourceId, existing),
      };
      await this.writeRecord(leasePath, renewed);
      return { ok: true, record: renewed };
    } finally {
      await this.releaseGuard(leasePath, guard);
    }
  }

  /** Delete the lease file when still self's; always drop local held inventory. */
  async release(commId: string, resourceId: string): Promise<void> {
    const leasePath = this.leasePath(commId, resourceId);
    const key = this.leaseKey(commId, resourceId);
    const guard = await this.acquireGuard(leasePath);
    try {
      const existing = await this.readRecord(leasePath);
      if (existing && existing.pid === this.self.pid) {
        await rm(leasePath, { force: true });
        this.audit({
          kind: "comm_lease_released",
          comm_id: commId,
          resource_id: resourceId,
          detail: { self_pid: this.self.pid },
        });
      }
    } finally {
      this.heldLeases.delete(key);
      if (guard) await this.releaseGuard(leasePath, guard);
    }
  }

  private leasePath(commId: string, resourceId: string): string {
    return commLeasePath(commId, resourceId, this.homeDir);
  }

  private leaseKey(commId: string, resourceId: string): string {
    return `${commId}:${resourceId}`;
  }

  private buildRecord(
    commId: string,
    resourceId: string,
    existing: LeaseRecord | null,
  ): LeaseRecord {
    const now = this.now();
    return {
      comm_id: commId,
      resource_id: resourceId,
      pid: this.self.pid,
      stateRoot: this.self.stateRoot,
      checkoutRoot: this.self.checkoutRoot,
      daemonBin: this.self.daemonBin,
      daemonVersion: this.self.daemonVersion,
      authorityRank: this.self.authorityRank,
      // Preserve the original acquisition time only if WE already held it.
      acquiredAt: existing && existing.pid === this.self.pid ? existing.acquiredAt : now,
      renewedAt: now,
      lastIpcServedAt: this.lastIpcServedAt(),
      process_start_time: this.processStartTimeForRecord(existing),
      agentProperties: this.agentPropertiesForRecord(commId, resourceId, existing),
    };
  }

  /**
   * Stamp native process-start identity only when the OS probe succeeds.
   * Preserves an existing self-held stamp; never writes uptime fallback.
   */
  private processStartTimeForRecord(existing: LeaseRecord | null): number | undefined {
    if (existing && existing.pid === this.self.pid && existing.process_start_time != null) {
      return existing.process_start_time;
    }
    const identity = this.readProcessStartIdentity(this.self.pid);
    return identity ?? undefined;
  }

  /**
   * Stamp agent properties from the locally desired map. A lease reclaimed from
   * another holder must never inherit the prior holder's properties.
   */
  private agentPropertiesForRecord(
    commId: string,
    resourceId: string,
    existing: LeaseRecord | null,
  ): AgentLeaseProperties | undefined {
    const desired = this.desiredAgentProperties.get(this.leaseKey(commId, resourceId));
    if (desired) return desired;
    if (existing && existing.pid === this.self.pid) return existing.agentProperties;
    return undefined;
  }

  private placeholderHolder(commId: string, resourceId: string): LeaseRecord {
    // Synthetic record for the "guard contended and no readable record" edge —
    // surfaces *something* to the caller without claiming ownership.
    return {
      comm_id: commId,
      resource_id: resourceId,
      pid: -1,
      stateRoot: "",
      checkoutRoot: null,
      daemonBin: null,
      daemonVersion: "",
      authorityRank: "worktree",
      acquiredAt: 0,
      renewedAt: 0,
      lastIpcServedAt: 0,
    };
  }

  private async readRecord(leasePath: string): Promise<LeaseRecord | null> {
    try {
      const raw = await readFile(leasePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LeaseRecord>;
      if (typeof parsed.pid !== "number" || typeof parsed.comm_id !== "string") return null;
      return parsed as LeaseRecord;
    } catch {
      return null;
    }
  }

  private async writeRecord(leasePath: string, record: LeaseRecord): Promise<void> {
    await mkdir(path.dirname(leasePath), { recursive: true });
    const handle = await open(leasePath, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  /**
   * Guard lock that serializes the read-decide-write. Uses the spawn-lock idiom
   * (O_EXCL create) on `<resource>.json.guard`. If the guard exists but its owner
   * pid is dead, reclaim it (stale-guard reclaim) so a crashed acquirer can't
   * wedge the lease forever.
   */
  private async acquireGuard(leasePath: string): Promise<string | null> {
    const guardPath = `${leasePath}.guard`;
    await mkdir(path.dirname(guardPath), { recursive: true });
    const token = `${this.self.pid}:${this.now()}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        await handle.writeFile(`${token}\n`, "utf8");
        await handle.close();
        return token;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        // Guard held — check whether its owner is dead (stale-guard reclaim).
        if (attempt === 0 && (await this.guardIsStale(guardPath))) {
          await rm(guardPath, { force: true });
          continue;
        }
        return null;
      }
    }
    return null;
  }

  private async guardIsStale(guardPath: string): Promise<boolean> {
    try {
      const raw = (await readFile(guardPath, "utf8")).trim();
      const pid = Number(raw.split(":")[0]);
      if (!Number.isInteger(pid) || pid <= 0) return true;
      if (pid === this.self.pid) return true; // our own leftover guard
      return !this.isPidAlive(pid);
    } catch {
      // If we can't read it, fall back to mtime: a guard older than the staleness
      // window is almost certainly orphaned.
      try {
        const info = await stat(guardPath);
        return this.now() - info.mtimeMs > this.stalenessMs;
      } catch {
        return false;
      }
    }
  }

  private async releaseGuard(leasePath: string, token: string): Promise<void> {
    const guardPath = `${leasePath}.guard`;
    try {
      const current = (await readFile(guardPath, "utf8")).trim();
      if (current === token) {
        await rm(guardPath, { force: true });
      }
    } catch {
      // Best-effort: a stale-guard reclaim on the next acquire handles leftovers.
    }
  }

  private audit(event: CommLeaseAuditEvent): void {
    if (!this.onAudit) return;
    try {
      this.onAudit(event);
    } catch {
      // Auditing must never break lease arbitration.
    }
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

// ---------------------------------------------------------------------------
// Lease-gating adapter wrapper.
// ---------------------------------------------------------------------------

export interface WrapWithLeaseOptions {
  /** Renewal interval while holding the lease (ms). */
  renewIntervalMs?: number;
  /** Slow re-acquire poll interval while denied (ms). */
  reacquireIntervalMs?: number;
  /** AGE-101: live eligibility verdict before each acquire/re-acquire attempt. */
  leaseEligible?: () => boolean | Promise<boolean>;
  /** Injected timer factory (tests). Defaults to setInterval/clearInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Loud logger. Defaults to console.error. */
  log?: (message: string) => void;
}

// Kept well below DEFAULT_IPC_RECENCY_MARGIN_MS (30s): the holder rewrites its
// lease `lastIpcServedAt` (= the daemon's most-recent IPC activity) on every
// renew, so a short interval keeps the PERSISTED activity current enough that
// the same-rank recency compare can never falsely supersede an actively-serving
// holder. The 3x headroom (10s renew vs 30s margin) also absorbs renewal jitter
// from event-loop lag. See AGE-35 review (item 1).
export const DEFAULT_RENEW_INTERVAL_MS = 10_000;
const DEFAULT_REACQUIRE_INTERVAL_MS = 60_000;

const leaseReacquireNudges = new Map<string, () => void>();

function leaseResourceKey(commId: string, resourceId: string): string {
  return `${commId}:${resourceId}`;
}

/**
 * AGE-102: immediately retry lease acquisition for a dormant denied wrapper.
 * Returns true when a registered wrapper was nudged.
 */
export function nudgeLeaseReacquire(commId: string, resourceId: string): boolean {
  const nudge = leaseReacquireNudges.get(leaseResourceKey(commId, resourceId));
  if (!nudge) return false;
  nudge();
  return true;
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
export function wrapWithLease(
  inner: CommAdapter,
  arbiter: CommLeaseArbiter,
  options: WrapWithLeaseOptions = {},
): CommAdapter {
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  const reacquireIntervalMs = options.reacquireIntervalMs ?? DEFAULT_REACQUIRE_INTERVAL_MS;
  const setIntervalFn =
    options.setIntervalFn ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearIntervalFn = options.clearIntervalFn ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  const log = options.log ?? ((m: string) => console.error(m));
  const leaseEligible = options.leaseEligible;

  const isLeaseEligible = async (): Promise<boolean> => {
    if (!leaseEligible) return true;
    try {
      return await leaseEligible();
    } catch {
      return false;
    }
  };

  let renewTimer: unknown = null;
  let reacquireTimer: unknown = null;
  let innerStarted = false;
  let holdingLease = false;

  const resource = inner.exclusiveResource?.() ?? null;

  const clearTimers = (): void => {
    if (renewTimer != null) {
      clearIntervalFn(renewTimer);
      renewTimer = null;
    }
    if (reacquireTimer != null) {
      clearIntervalFn(reacquireTimer);
      reacquireTimer = null;
    }
  };

  const startRenewTimer = (resourceId: string): void => {
    if (renewTimer != null) return;
    renewTimer = setIntervalFn(() => {
      void arbiter
        .renew(inner.id, resourceId)
        .then(async (result) => {
          if (result.ok) return;
          // Lost the lease (reclaimed by a higher/equal-rank daemon). Stop the
          // inner adapter and switch to slow re-acquire.
          holdingLease = false;
          if (renewTimer != null) {
            clearIntervalFn(renewTimer);
            renewTimer = null;
          }
          log(
            `comm ${inner.id} resource ${resourceId}: LOST the poll lease ` +
              `(reclaimed by pid ${result.holder?.pid ?? "?"}); stopping this consumer.`,
          );
          if (innerStarted) {
            try {
              await inner.stop();
            } catch {
              // best-effort
            }
            innerStarted = false;
          }
          startReacquireTimer(resourceId);
        })
        .catch(() => {
          // Renew error — keep running; next tick retries.
        });
    }, renewIntervalMs);
  };

  const startReacquireTimer = (resourceId: string): void => {
    if (reacquireTimer != null) return;
    reacquireTimer = setIntervalFn(() => {
      void attemptReacquire(resourceId);
    }, reacquireIntervalMs);
  };

  const attemptReacquire = async (resourceId: string): Promise<void> => {
    try {
      const eligible = await isLeaseEligible();
      const result = await arbiter.tryAcquire(inner.id, resourceId, { eligible });
      if (!result.ok) {
        startReacquireTimer(resourceId);
        return;
      }
      if (reacquireTimer != null) {
        clearIntervalFn(reacquireTimer);
        reacquireTimer = null;
      }
      holdingLease = true;
      log(
        `comm ${inner.id} resource ${resourceId}: acquired the poll lease ` +
          `on re-acquire; starting this consumer.`,
      );
      try {
        await inner.start();
        innerStarted = true;
        startRenewTimer(resourceId);
      } catch (error) {
        innerStarted = false;
        holdingLease = false;
        log(
          `comm ${inner.id} resource ${resourceId}: inner.start() failed after ` +
            `re-acquire: ${error instanceof Error ? error.message : String(error)}; ` +
            `releasing lease.`,
        );
        await arbiter.release(inner.id, resourceId).catch(() => {});
        startReacquireTimer(resourceId);
      }
    } catch {
      startReacquireTimer(resourceId);
    }
  };

  const nudgeReacquire = (): void => {
    if (!resource) return;
    if (holdingLease || innerStarted) return;
    if (reacquireTimer != null) {
      clearIntervalFn(reacquireTimer);
      reacquireTimer = null;
    }
    void attemptReacquire(resource.resourceId).catch(() => {});
  };

  if (resource) {
    leaseReacquireNudges.set(leaseResourceKey(inner.id, resource.resourceId), nudgeReacquire);
  }

  const proxy: CommAdapter = {
    get id() {
      return inner.id;
    },
    get accountId() {
      return inner.accountId;
    },
    get allowedSenderIds() {
      return inner.allowedSenderIds;
    },
    updateAllowedSenderIds: inner.updateAllowedSenderIds
      ? (ids) => inner.updateAllowedSenderIds!(ids)
      : undefined,
    exclusiveResource: inner.exclusiveResource ? () => inner.exclusiveResource!() : undefined,

    async start(): Promise<void> {
      if (!resource) {
        await inner.start();
        innerStarted = true;
        return;
      }
      const eligible = await isLeaseEligible();
      const result = await arbiter.tryAcquire(inner.id, resource.resourceId, { eligible });
      if (!result.ok) {
        holdingLease = false;
        log(
          `comm ${inner.id} resource ${resource.resourceId}: another daemon owns the ` +
            `poll lease (holder pid ${result.holder.pid}, checkout ` +
            `${result.holder.checkoutRoot ?? "?"}); not starting a second consumer.`,
        );
        startReacquireTimer(resource.resourceId);
        return;
      }
      holdingLease = true;
      try {
        await inner.start();
        innerStarted = true;
        startRenewTimer(resource.resourceId);
      } catch (error) {
        innerStarted = false;
        holdingLease = false;
        // AGE-38: the inner adapter may have partially started before throwing
        // (e.g. a Telegram poller spins up before `getMe()` resolves) — best-effort
        // stop it so a failed start doesn't leak a poller consuming getUpdates
        // outside the bus, THEN release the lease so a peer can try.
        await inner.stop().catch(() => {});
        await arbiter.release(inner.id, resource.resourceId).catch(() => {});
        throw error;
      }
    },

    async stop(): Promise<void> {
      clearTimers();
      if (resource) {
        leaseReacquireNudges.delete(leaseResourceKey(inner.id, resource.resourceId));
      }
      try {
        if (innerStarted) await inner.stop();
      } finally {
        innerStarted = false;
        if (resource && holdingLease) {
          await arbiter.release(inner.id, resource.resourceId).catch(() => {});
        }
        holdingLease = false;
      }
    },

    onInbound(handler) {
      inner.onInbound(handler);
    },
    onConnectionState(handler) {
      inner.onConnectionState(handler);
    },
    send(target, payload, idempotencyKey) {
      return inner.send(target, payload, idempotencyKey);
    },
    reportPressure() {
      return inner.reportPressure();
    },
    classifyFailure(error) {
      return inner.classifyFailure(error);
    },
    onCallback: inner.onCallback ? (handler) => inner.onCallback!(handler) : undefined,
    answerCallback: inner.answerCallback
      ? (callbackId, opts) => inner.answerCallback!(callbackId, opts)
      : undefined,
    editMessage: inner.editMessage
      ? (chatNativeId, messageNativeId, text, opts) =>
          inner.editMessage!(chatNativeId, messageNativeId, text, opts)
      : undefined,
  };

  return proxy;
}
