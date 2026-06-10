import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  DEFAULT_HEARTBEAT_MAX_MS,
  DEFAULT_HEARTBEAT_MIN_MS,
  startEnsureCommsHeartbeat,
} from "../../hosts/common/mcp-shim-shared.js";

function makeScheduler() {
  const delays: number[] = [];
  const timers = new Map<number, { fn: () => void; delayMs: number; unrefCalled: boolean }>();
  let nextId = 1;

  const scheduleTimer = (fn: () => void, delayMs: number) => {
    const id = nextId++;
    delays.push(delayMs);
    const handle = {
      id,
      cancel() {
        timers.delete(id);
      },
      unref() {
        const entry = timers.get(id);
        if (entry) entry.unrefCalled = true;
      },
    };
    timers.set(id, { fn, delayMs, unrefCalled: false });
    return handle;
  };

  const fire = (index = 0) => {
    const id = [...timers.keys()][index];
    const entry = timers.get(id);
    if (!entry) throw new Error(`no timer at index ${index}`);
    timers.delete(id);
    entry.fn();
    return entry;
  };

  const pending = () => [...timers.values()];

  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  return { delays, scheduleTimer, fire, pending, flush };
}

describe("AGE-53 Phase 2 ensure_comms heartbeat", () => {
  it("schedules the first fire with a randomized delay within [MIN, MAX]", () => {
    let randomCalls = 0;
    const { delays, scheduleTimer } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 1_000,
      maxMs: 2_000,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => {
          randomCalls += 1;
          return 0.5;
        },
        scheduleTimer,
        pathExists: () => false,
        ensureCommsForScopeAtStartup: async () => ({ ok: true }),
      },
    });

    assert.equal(randomCalls, 1);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 1_000 && delays[0] <= 2_000, `delay ${delays[0]} outside window`);
  });

  it("fires ensure after a jittered delay within [MIN, MAX]", async () => {
    const ensureCalls: number[] = [];
    const { delays, scheduleTimer, fire, flush } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 100,
      maxMs: 200,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0.25,
        scheduleTimer,
        pathExists: () => false,
        ensureCommsForScopeAtStartup: async () => {
          ensureCalls.push(Date.now());
          return { ok: true };
        },
      },
    });

    assert.equal(delays[0], 125);
    fire(0);
    await flush();
    assert.equal(ensureCalls.length, 1);
    assert.equal(delays[1], 125);
  });

  it("skips ensure when the paused marker exists but keeps scheduling", async () => {
    const ensureCalls: string[] = [];
    const { scheduleTimer, fire, pending, flush } = makeScheduler();
    const stateRoot = "/state";

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 50,
      maxMs: 50,
      resolveStateRoot: () => stateRoot,
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: (path) => path === join(stateRoot, "paused"),
        ensureCommsForScopeAtStartup: async () => {
          ensureCalls.push("ensure");
          return { ok: true };
        },
      },
    });

    fire(0);
    await flush();
    assert.equal(ensureCalls.length, 0);
    assert.equal(pending().length, 1);
  });

  it("logs a failure once across repeated failures and re-logs after success", async () => {
    const messages: string[] = [];
    let fail = true;
    const { scheduleTimer, fire, flush } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        log: (message: string) => {
          messages.push(message);
        },
        ensureCommsForScopeAtStartup: async () =>
          fail ? { ok: false, message: "daemon down" } : { ok: true },
      },
    });

    fire(0);
    await flush();
    fire(0);
    await flush();
    assert.equal(messages.length, 1);
    assert.match(messages[0], /heartbeat failed: daemon down/);

    fail = false;
    fire(0);
    await flush();
    fail = true;
    fire(0);
    await flush();
    assert.equal(messages.length, 2);
    assert.match(messages[1], /heartbeat failed: daemon down/);
  });

  it("unrefs every scheduled timer", () => {
    const { scheduleTimer, pending } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 100,
      maxMs: 100,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        ensureCommsForScopeAtStartup: async () => ({ ok: true }),
      },
    });

    assert.equal(pending().length, 1);
    assert.equal(pending()[0].unrefCalled, true);
  });

  it("stop() cancels the next fire", async () => {
    const ensureCalls: string[] = [];
    const { scheduleTimer, fire, flush } = makeScheduler();

    const heartbeat = startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        ensureCommsForScopeAtStartup: async () => {
          ensureCalls.push("ensure");
          return { ok: true };
        },
      },
    });

    heartbeat.stop();
    assert.throws(() => fire(0), /no timer at index 0/);
    await flush();
    assert.equal(ensureCalls.length, 0);
  });

  it("defaults heartbeat window to five to ten minutes", () => {
    assert.equal(DEFAULT_HEARTBEAT_MIN_MS, 5 * 60 * 1_000);
    assert.equal(DEFAULT_HEARTBEAT_MAX_MS, 10 * 60 * 1_000);
  });

  it("calls ensureWatcher on each tick when injected", async () => {
    const watcherCalls: number[] = [];
    const ensureCalls: number[] = [];
    const { scheduleTimer, fire, flush } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        ensureCommsForScopeAtStartup: async () => {
          ensureCalls.push(Date.now());
          return { ok: true };
        },
        ensureWatcher: async () => {
          watcherCalls.push(Date.now());
          return { started: false, reason: "already_running" };
        },
      },
    });

    fire(0);
    await flush();
    assert.equal(ensureCalls.length, 1);
    assert.equal(watcherCalls.length, 1);

    fire(0);
    await flush();
    assert.equal(ensureCalls.length, 2);
    assert.equal(watcherCalls.length, 2);
  });

  it("logs each respawn when ensureWatcher returns started:true", async () => {
    const messages: string[] = [];
    const { scheduleTimer, fire, flush } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        log: (message: string) => {
          messages.push(message);
        },
        ensureCommsForScopeAtStartup: async () => ({ ok: true }),
        ensureWatcher: async () => ({ started: true, pid: 4242 }),
      },
    });

    fire(0);
    await flush();
    fire(0);
    await flush();
    assert.equal(
      messages.filter((message) => message.includes("enter-watcher was dead")).length,
      2,
    );
    assert.match(messages[0], /respawned \(pid 4242\)/);
  });

  it("skips ensureWatcher when the paused marker exists", async () => {
    const watcherCalls: string[] = [];
    const { scheduleTimer, fire, flush } = makeScheduler();
    const stateRoot = "/state";

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => stateRoot,
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: (path) => path === join(stateRoot, "paused"),
        ensureCommsForScopeAtStartup: async () => ({ ok: true }),
        ensureWatcher: async () => {
          watcherCalls.push("watcher");
          return { started: false, reason: "already_running" };
        },
      },
    });

    fire(0);
    await flush();
    assert.equal(watcherCalls.length, 0);
  });

  it("ensureWatcher throwing does not break ensure-comms or reschedule", async () => {
    const ensureCalls: string[] = [];
    const messages: string[] = [];
    const { scheduleTimer, fire, pending, flush } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        log: (message: string) => {
          messages.push(message);
        },
        ensureCommsForScopeAtStartup: async () => {
          ensureCalls.push("ensure");
          return { ok: true };
        },
        ensureWatcher: async () => {
          throw new Error("watcher boom");
        },
      },
    });

    fire(0);
    await flush();
    assert.equal(ensureCalls.length, 1);
    assert.equal(pending().length, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /enter-watcher heartbeat failed: watcher boom/);
  });

  it("logs watcher failure once and re-logs after success", async () => {
    const messages: string[] = [];
    let failWatcher = true;
    const { scheduleTimer, fire, flush } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        log: (message: string) => {
          messages.push(message);
        },
        ensureCommsForScopeAtStartup: async () => ({ ok: true }),
        ensureWatcher: async () =>
          failWatcher
            ? { started: false, reason: "spawn_error", error: "spawn failed" }
            : { started: false, reason: "already_running" },
      },
    });

    fire(0);
    await flush();
    fire(0);
    await flush();
    assert.equal(
      messages.filter((message) => message.includes("enter-watcher heartbeat failed")).length,
      1,
    );

    failWatcher = false;
    fire(0);
    await flush();
    failWatcher = true;
    fire(0);
    await flush();
    assert.equal(
      messages.filter((message) => message.includes("enter-watcher heartbeat failed")).length,
      2,
    );
  });

  it("behaves unchanged when ensureWatcher is not injected", async () => {
    const ensureCalls: string[] = [];
    const messages: string[] = [];
    const { scheduleTimer, fire, flush } = makeScheduler();

    startEnsureCommsHeartbeat({
      agentInUse: () => "claude",
      minMs: 10,
      maxMs: 10,
      resolveStateRoot: () => "/state",
      deps: {
        random: () => 0,
        scheduleTimer,
        pathExists: () => false,
        log: (message: string) => {
          messages.push(message);
        },
        ensureCommsForScopeAtStartup: async () => {
          ensureCalls.push("ensure");
          return { ok: true };
        },
      },
    });

    fire(0);
    await flush();
    assert.equal(ensureCalls.length, 1);
    assert.equal(messages.length, 0);
  });
});
