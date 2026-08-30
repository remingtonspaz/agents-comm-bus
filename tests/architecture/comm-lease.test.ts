import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUTHORITY_RANK_ORDER,
  CommLeaseArbiter,
  commLeasePath,
  decideContention,
  inferAuthorityRank,
  wrapWithLease,
  DEFAULT_RENEW_INTERVAL_MS,
  DEFAULT_IPC_RECENCY_MARGIN_MS,
  type LeaseRecord,
  type SelfIdentity,
} from "../../core-daemon/runtime/comm-lease.js";
import type { CommAdapter, CommId, AccountId } from "agents-comm-bus-core";

const DAEMON_DOTDIR = ".agents-comm-bus";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "acb-lease-home-"));
}

/** Poll a predicate until true or the deadline, draining the microtask + I/O queue. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setImmediate(r));
  }
}

function selfIdentity(over: Partial<SelfIdentity> = {}): SelfIdentity {
  return {
    pid: 1000,
    stateRoot: "/state/a",
    checkoutRoot: "/checkout/a",
    daemonBin: null,
    daemonVersion: "0.0.0",
    authorityRank: "main-dev",
    ...over,
  };
}

// A minimal fake adapter — never a real comm. Records start/stop calls.
class FakeAdapter {
  readonly id = "fakecomm" as unknown as CommId;
  readonly accountId: AccountId;
  startCount = 0;
  stopCount = 0;
  private resource: { resourceId: string } | null;

  constructor(resourceId: string | null, accountId = "acct-1") {
    this.accountId = accountId as unknown as AccountId;
    this.resource = resourceId == null ? null : { resourceId };
  }

  exclusiveResource(): { resourceId: string } | null {
    return this.resource;
  }
  async start(): Promise<void> {
    this.startCount += 1;
  }
  async stop(): Promise<void> {
    this.stopCount += 1;
  }
  onInbound(): void {}
  onConnectionState(): void {}
  async send(): Promise<never> {
    throw new Error("not used");
  }
  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure(): "transient" {
    return "transient";
  }
}

describe("AGE-35 comm lease path", () => {
  it("anchors at the FIXED homedir path, not the state root", () => {
    const home = "/home/satrio";
    const p = commLeasePath("telegram", "8950482517", home);
    assert.equal(
      p,
      path.join(home, DAEMON_DOTDIR, "comm-locks", "telegram", "8950482517.json"),
    );
  });

  it("sanitizes unsafe segments in comm/resource ids", () => {
    const home = "/home/x";
    const p = commLeasePath("tele/gram", "a b:c", home);
    assert.equal(p, path.join(home, DAEMON_DOTDIR, "comm-locks", "tele_gram", "a_b_c.json"));
  });
});

describe("AGE-35 authority-rank inference", () => {
  it("infers production when the bin is under ~/.agents-comm-bus/bin/", () => {
    const home = "/home/u";
    const bin = path.join(home, DAEMON_DOTDIR, "bin", "daemon.js");
    const inf = inferAuthorityRank({
      env: { AGENTS_COMM_BUS_BIN: bin },
      daemonBin: bin,
      cwd: "/whatever",
      homeDir: home,
      fileExists: () => false,
      isDirectory: () => false,
    });
    assert.equal(inf.authorityRank, "production");
  });

  it("infers main-dev when .git is a directory", () => {
    // Resolve so the expectation matches the implementation's resolved walk
    // (path.resolve adds the drive letter on Windows).
    const checkout = path.resolve("/dev/main-checkout");
    const gitPath = path.join(checkout, ".git");
    const inf = inferAuthorityRank({
      env: {},
      daemonBin: path.join(checkout, "agents-comm-bus", "dist", "core-daemon", "serve.js"),
      cwd: path.resolve("/whatever"),
      homeDir: path.resolve("/home/u"),
      fileExists: (p) => p === gitPath,
      isDirectory: (p) => p === gitPath,
    });
    assert.equal(inf.authorityRank, "main-dev");
    assert.equal(inf.checkoutRoot, checkout);
  });

  it("infers worktree when .git is a FILE (git worktree)", () => {
    const checkout = path.resolve("/tmp/worktree-x");
    const gitPath = path.join(checkout, ".git");
    const inf = inferAuthorityRank({
      env: {},
      daemonBin: path.join(checkout, "agents-comm-bus", "dist", "core-daemon", "serve.js"),
      cwd: path.resolve("/whatever"),
      homeDir: path.resolve("/home/u"),
      fileExists: (p) => p === gitPath,
      isDirectory: () => false, // .git is a file
    });
    assert.equal(inf.authorityRank, "worktree");
    assert.equal(inf.checkoutRoot, checkout);
  });

  it("defaults to worktree (lowest) when undeterminable", () => {
    const inf = inferAuthorityRank({
      env: {},
      daemonBin: null,
      cwd: "/no/git/here",
      homeDir: "/home/u",
      fileExists: () => false,
      isDirectory: () => false,
    });
    assert.equal(inf.authorityRank, "worktree");
    assert.equal(inf.checkoutRoot, null);
  });

  it("ranks main-dev > production > worktree", () => {
    assert.ok(AUTHORITY_RANK_ORDER["main-dev"] > AUTHORITY_RANK_ORDER["production"]);
    assert.ok(AUTHORITY_RANK_ORDER["production"] > AUTHORITY_RANK_ORDER["worktree"]);
  });
});

describe("AGE-35 decideContention (pure)", () => {
  const baseArgs = {
    commId: "fakecomm",
    resourceId: "r1",
    now: 10_000,
    isPidAlive: () => true,
    stalenessMs: 90_000,
    ipcRecencyMarginMs: 30_000,
  };

  function holder(over: Partial<LeaseRecord> = {}): LeaseRecord {
    return {
      comm_id: "fakecomm",
      resource_id: "r1",
      pid: 2000,
      stateRoot: "/state/h",
      checkoutRoot: "/checkout/h",
      daemonBin: null,
      daemonVersion: "0.0.0",
      authorityRank: "main-dev",
      acquiredAt: 0,
      renewedAt: 9_500,
      lastIpcServedAt: 9_500,
      ...over,
    };
  }

  it("takes when there is no holder", () => {
    const d = decideContention({
      ...baseArgs,
      self: selfIdentity(),
      selfLastIpcServedAt: 10_000,
      existing: null,
    });
    assert.deepEqual(d, { take: true, reason: "no-holder" });
  });

  it("takes when the holder pid is dead", () => {
    const d = decideContention({
      ...baseArgs,
      isPidAlive: () => false,
      self: selfIdentity({ authorityRank: "worktree" }),
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "main-dev" }),
    });
    assert.equal(d.take, true);
    assert.equal((d as { reason: string }).reason, "holder-dead");
  });

  it("takes when the holder is stale (renewedAt old)", () => {
    const d = decideContention({
      ...baseArgs,
      now: 200_000,
      self: selfIdentity({ authorityRank: "worktree" }),
      selfLastIpcServedAt: 200_000,
      existing: holder({ authorityRank: "main-dev", renewedAt: 1_000 }),
    });
    assert.equal(d.take, true);
    assert.equal((d as { reason: string }).reason, "holder-stale");
  });

  it("reclaims when the contender outranks the holder", () => {
    const d = decideContention({
      ...baseArgs,
      self: selfIdentity({ authorityRank: "main-dev" }),
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "production" }),
    });
    assert.equal(d.take, true);
    assert.equal((d as { reason: string }).reason, "higher-rank");
  });

  it("DENIES a lower-rank contender against a live higher-rank holder (even if fresher)", () => {
    const d = decideContention({
      ...baseArgs,
      self: selfIdentity({ authorityRank: "worktree" }),
      // Contender is much fresher, but rank dominates — must NOT steal.
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "main-dev", lastIpcServedAt: 1_000 }),
    });
    assert.equal(d.take, false);
    assert.equal((d as { reason: string }).reason, "held-by-higher-rank");
  });

  it("same-rank: supersedes a clearly-staler holder by lastIpcServedAt", () => {
    const d = decideContention({
      ...baseArgs,
      self: selfIdentity({ authorityRank: "production" }),
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "production", lastIpcServedAt: 10_000 - 30_001 }),
    });
    assert.equal(d.take, true);
    assert.equal((d as { reason: string }).reason, "same-rank-staler-holder");
  });

  it("same-rank: DENIES when both are fresh (ambiguous, don't guess)", () => {
    const d = decideContention({
      ...baseArgs,
      self: selfIdentity({ authorityRank: "production" }),
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "production", lastIpcServedAt: 9_990 }),
    });
    assert.equal(d.take, false);
    assert.equal((d as { reason: string }).reason, "held-by-same-rank-fresh");
  });

  it("same-rank: does NOT supersede when the holder is only slightly staler (within margin)", () => {
    const d = decideContention({
      ...baseArgs,
      self: selfIdentity({ authorityRank: "production" }),
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "production", lastIpcServedAt: 10_000 - 29_999 }),
    });
    assert.equal(d.take, false);
  });

  it("config: the same-rank margin keeps >=3x headroom over the renew interval (review item 1)", () => {
    // The holder's PERSISTED lastIpcServedAt lags its true activity by up to one
    // renew interval (refreshed only on renew); the margin must absorb that lag,
    // else an actively-serving same-rank holder could be falsely superseded.
    assert.ok(DEFAULT_IPC_RECENCY_MARGIN_MS >= 3 * DEFAULT_RENEW_INTERVAL_MS);
  });

  it("does NOT supersede a same-rank holder lagging by one renew interval (review item 1)", () => {
    // Models the gap Codex flagged: the holder served IPC right up to `now`, but
    // its persisted lease value is one full renew interval old. That lag must NOT
    // be enough to steal the lease from an actively-serving same-rank holder.
    const d = decideContention({
      ...baseArgs,
      self: selfIdentity({ authorityRank: "production" }),
      selfLastIpcServedAt: baseArgs.now,
      existing: holder({
        authorityRank: "production",
        lastIpcServedAt: baseArgs.now - DEFAULT_RENEW_INTERVAL_MS,
      }),
    });
    assert.equal(d.take, false);
    assert.equal((d as { reason: string }).reason, "held-by-same-rank-fresh");
  });
});

describe("AGE-35 CommLeaseArbiter (filesystem)", () => {
  it("first arbiter acquires; a second same-rank live arbiter is DENIED", async () => {
    const home = await tempHome();
    const now = { t: 1_000 };
    const aliveSet = new Set<number>([10, 20]);
    const clock = () => now.t;

    const a = new CommLeaseArbiter({
      self: selfIdentity({ pid: 10, authorityRank: "production", stateRoot: "/state/a" }),
      lastIpcServedAt: () => now.t,
      homeDir: home,
      isPidAlive: (pid) => aliveSet.has(pid),
      now: clock,
    });
    const b = new CommLeaseArbiter({
      self: selfIdentity({ pid: 20, authorityRank: "production", stateRoot: "/state/b" }),
      lastIpcServedAt: () => now.t,
      homeDir: home,
      isPidAlive: (pid) => aliveSet.has(pid),
      now: clock,
    });

    const r1 = await a.tryAcquire("fakecomm", "res1");
    assert.equal(r1.ok, true);
    assert.ok(existsSync(commLeasePath("fakecomm", "res1", home)));

    const r2 = await b.tryAcquire("fakecomm", "res1");
    assert.equal(r2.ok, false);
    if (!r2.ok) {
      assert.equal(r2.reason, "held-by-same-rank-fresh");
      assert.equal(r2.holder.pid, 10);
    }
  });

  it("higher-rank contender reclaims a live lower-rank holder", async () => {
    const home = await tempHome();
    const now = () => 5_000;
    const low = new CommLeaseArbiter({
      self: selfIdentity({ pid: 30, authorityRank: "worktree" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });
    const high = new CommLeaseArbiter({
      self: selfIdentity({ pid: 40, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });

    assert.equal((await low.tryAcquire("fakecomm", "res")).ok, true);
    const reclaim = await high.tryAcquire("fakecomm", "res");
    assert.equal(reclaim.ok, true);

    const onDisk = JSON.parse(
      await readFile(commLeasePath("fakecomm", "res", home), "utf8"),
    ) as LeaseRecord;
    assert.equal(onDisk.pid, 40);
    assert.equal(onDisk.authorityRank, "main-dev");
  });

  it("lower-rank contender does NOT steal from a live higher-rank holder", async () => {
    const home = await tempHome();
    const now = () => 5_000;
    const high = new CommLeaseArbiter({
      self: selfIdentity({ pid: 50, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });
    const low = new CommLeaseArbiter({
      self: selfIdentity({ pid: 60, authorityRank: "worktree" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });

    assert.equal((await high.tryAcquire("fakecomm", "res")).ok, true);
    const denied = await low.tryAcquire("fakecomm", "res");
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason, "held-by-higher-rank");

    const onDisk = JSON.parse(
      await readFile(commLeasePath("fakecomm", "res", home), "utf8"),
    ) as LeaseRecord;
    assert.equal(onDisk.pid, 50, "higher-rank holder must remain the owner");
  });

  it("steals from a dead holder regardless of rank", async () => {
    const home = await tempHome();
    const now = () => 5_000;
    const alive = new Set<number>([70]); // the holder (80) is NOT alive
    const dead = new CommLeaseArbiter({
      self: selfIdentity({ pid: 80, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now,
    });
    const live = new CommLeaseArbiter({
      self: selfIdentity({ pid: 70, authorityRank: "worktree" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now,
    });

    assert.equal((await dead.tryAcquire("fakecomm", "res")).ok, true);
    // Holder pid 80 is now dead; the live worktree daemon may steal it.
    const stolen = await live.tryAcquire("fakecomm", "res");
    assert.equal(stolen.ok, true);
    const onDisk = JSON.parse(
      await readFile(commLeasePath("fakecomm", "res", home), "utf8"),
    ) as LeaseRecord;
    assert.equal(onDisk.pid, 70);
  });

  it("renew refreshes timestamps while held; reports lost after a reclaim", async () => {
    const home = await tempHome();
    const now = { t: 1_000 };
    const holderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 90, authorityRank: "production" }),
      lastIpcServedAt: () => now.t,
      homeDir: home,
      isPidAlive: () => true,
      now: () => now.t,
    });
    const reclaimer = new CommLeaseArbiter({
      self: selfIdentity({ pid: 91, authorityRank: "main-dev" }),
      lastIpcServedAt: () => now.t,
      homeDir: home,
      isPidAlive: () => true,
      now: () => now.t,
    });

    assert.equal((await holderArb.tryAcquire("fakecomm", "res")).ok, true);
    now.t = 2_000;
    const renew1 = await holderArb.renew("fakecomm", "res");
    assert.equal(renew1.ok, true);
    if (renew1.ok) assert.equal(renew1.record.renewedAt, 2_000);

    // A higher-rank daemon reclaims it.
    assert.equal((await reclaimer.tryAcquire("fakecomm", "res")).ok, true);
    const renew2 = await holderArb.renew("fakecomm", "res");
    assert.equal(renew2.ok, false);
    if (!renew2.ok) assert.equal(renew2.reason, "lost");
  });

  it("release deletes the file only when it is still self's", async () => {
    const home = await tempHome();
    const now = () => 1_000;
    const owner = new CommLeaseArbiter({
      self: selfIdentity({ pid: 100, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });
    const other = new CommLeaseArbiter({
      self: selfIdentity({ pid: 101, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });

    assert.equal((await owner.tryAcquire("fakecomm", "res")).ok, true);
    const leasePath = commLeasePath("fakecomm", "res", home);

    // `other` does not hold it → release must NOT delete it.
    await other.release("fakecomm", "res");
    assert.ok(existsSync(leasePath), "non-owner release must not delete the lease");

    await owner.release("fakecomm", "res");
    assert.ok(!existsSync(leasePath), "owner release must delete the lease");
  });

  it("dedups steady-state denials: audits once per episode, re-audits on holder change or after a take", async () => {
    // The slow re-acquire poll re-attempts a lease it cannot win every
    // DEFAULT_REACQUIRE_INTERVAL_MS forever; without dedup that floods the audit
    // log with thousands of identical `comm_lease_denied` rows. Audit is for
    // TRANSITIONS — emit on the first denial of a streak, on a holder/reason
    // change, and again after we held-and-lost; stay silent on steady-state polls.
    const home = await tempHome();
    const now = () => 5_000;
    const aliveSet = new Set<number>([400, 401, 402, 410]);
    const isPidAlive = (pid: number): boolean => aliveSet.has(pid);

    const holder1 = new CommLeaseArbiter({
      self: selfIdentity({ pid: 400, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive,
      now,
    });
    assert.equal((await holder1.tryAcquire("fakecomm", "res-dd")).ok, true);

    const denied: Array<{ holderPid: unknown; reason: unknown }> = [];
    const contender = new CommLeaseArbiter({
      self: selfIdentity({ pid: 410, authorityRank: "worktree" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive,
      now,
      onAudit: (e) => {
        if (e.kind === "comm_lease_denied") {
          denied.push({ holderPid: e.detail.holder_pid, reason: e.detail.reason });
        }
      },
    });

    // 5 identical steady-state polls → ONE audit.
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await contender.tryAcquire("fakecomm", "res-dd")).ok, false);
    }
    assert.equal(denied.length, 1, "repeated identical denials must audit once");
    assert.equal(denied[0].holderPid, 400);

    // Holder CHANGES (400 dies, 401 takes over) → the next denial re-audits.
    aliveSet.delete(400);
    const holder2 = new CommLeaseArbiter({
      self: selfIdentity({ pid: 401, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive,
      now,
    });
    assert.equal((await holder2.tryAcquire("fakecomm", "res-dd")).ok, true);
    assert.equal((await contender.tryAcquire("fakecomm", "res-dd")).ok, false);
    assert.equal(denied.length, 2, "a changed holder must re-audit");
    assert.equal(denied[1].holderPid, 401);

    // Same holder again → still deduped.
    assert.equal((await contender.tryAcquire("fakecomm", "res-dd")).ok, false);
    assert.equal(denied.length, 2, "same holder again must not re-audit");

    // TAKE-RESET: contender takes when the holder dies, a higher-rank reclaims,
    // and the contender's next denial re-audits (signature cleared on the take).
    aliveSet.delete(401);
    assert.equal((await contender.tryAcquire("fakecomm", "res-dd")).ok, true);
    const holder3 = new CommLeaseArbiter({
      self: selfIdentity({ pid: 402, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive,
      now,
    });
    assert.equal((await holder3.tryAcquire("fakecomm", "res-dd")).ok, true);
    assert.equal((await contender.tryAcquire("fakecomm", "res-dd")).ok, false);
    assert.equal(denied.length, 3, "a denial after held-and-lost must re-audit");
    assert.equal(denied[2].holderPid, 402);
  });
});

describe("AGE-35 wrapWithLease", () => {
  // Manual timer control so the tests are deterministic and don't hang.
  function makeTimers() {
    const handles = new Map<number, () => void>();
    let nextId = 1;
    return {
      setIntervalFn: (fn: () => void) => {
        const id = nextId++;
        handles.set(id, fn);
        return id;
      },
      clearIntervalFn: (h: unknown) => {
        handles.delete(h as number);
      },
      fire: async (id: number) => {
        const fn = handles.get(id);
        if (fn) fn();
      },
      count: () => handles.size,
    };
  }

  it("does not wrap-gate adapters with no exclusive resource (null) — starts directly", async () => {
    const home = await tempHome();
    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 200 }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 0,
    });
    const inner = new FakeAdapter(null);
    const wrapped = wrapWithLease(inner as unknown as CommAdapter, arb);
    await wrapped.start();
    assert.equal(inner.startCount, 1);
    // No lease file should have been written.
    await wrapped.stop();
    assert.equal(inner.stopCount, 1);
  });

  it("acquired → inner.start() called + lease file written; stop() releases", async () => {
    const home = await tempHome();
    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 210, authorityRank: "main-dev" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 0,
    });
    const timers = makeTimers();
    const inner = new FakeAdapter("res-acq");
    const wrapped = wrapWithLease(inner as unknown as CommAdapter, arb, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      log: () => {},
    });

    await wrapped.start();
    assert.equal(inner.startCount, 1, "inner.start must be called once acquired");
    const leasePath = commLeasePath("fakecomm", "res-acq", home);
    assert.ok(existsSync(leasePath), "lease file must be written on acquire");

    await wrapped.stop();
    assert.equal(inner.stopCount, 1);
    assert.ok(!existsSync(leasePath), "stop() must release the lease");
  });

  it("denied → inner.start() NOT called; reacquires when the holder dies", async () => {
    const home = await tempHome();
    const now = () => 0;
    const aliveSet = new Set<number>([300, 310]);

    // Pre-seed a higher-rank holder (pid 300).
    const holderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 300, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: (pid) => aliveSet.has(pid),
      now,
    });
    assert.equal((await holderArb.tryAcquire("fakecomm", "res-deny")).ok, true);

    // The contender is lower-rank (worktree) → must be denied and NOT start.
    const contenderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 310, authorityRank: "worktree" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: (pid) => aliveSet.has(pid),
      now,
    });
    const timers = makeTimers();
    const inner = new FakeAdapter("res-deny");
    const wrapped = wrapWithLease(inner as unknown as CommAdapter, contenderArb, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      log: () => {},
    });

    await wrapped.start();
    assert.equal(inner.startCount, 0, "denied contender must NOT start the inner adapter");
    assert.equal(timers.count(), 1, "a slow re-acquire timer must be armed");

    // Now the holder dies; firing the re-acquire timer must let the contender take it.
    aliveSet.delete(300);
    const timerId = 1;
    await timers.fire(timerId);
    await waitFor(() => inner.startCount === 1);
    assert.equal(inner.startCount, 1, "contender must start once the holder is gone");

    await wrapped.stop();
    assert.equal(inner.stopCount, 1);
  });
});
