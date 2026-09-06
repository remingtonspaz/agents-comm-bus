import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDaemon } from "../../core-daemon/bootstrap/ensure-daemon.js";
import { createProcessStartIdentityCache, probeProcessIdentities } from "../../core-daemon/runtime/process-start-epoch.js";
import type { DaemonHello } from "../../core-daemon/ipc/protocol.js";
import { WebSocketServer } from "ws";
import { runSessionEndSweep } from "../../core-daemon/runtime/session-end-sweep.js";
import { sessionFixture } from "./_session-fixture.js";
import type { Storage, SessionId, AgentId } from "../../packages/core-contracts/src/index.js";
import { sessionLeaseOwnerWithDaemon, type DaemonSelfIdentity } from "../../core-daemon/runtime/agent-bridge.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";

const hello: DaemonHello = { type: "daemon.hello", daemonName: "agents-comm-bus",
  protocolVersion: "1.2.0", daemonVersion: "0.2.62" };

test("AGE-104: busy live daemon keeps discovery and is never replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "age104-busy-"));
  let spawns = 0;
  try {
    await writeFile(path.join(root, "port"), "12345\n");
    await writeFile(path.join(root, "daemon.pid"), "1234\n");
    await assert.rejects(ensureDaemon({
      stateRoot: root, discoveryRoot: root, env: {}, timeoutMs: 80, retryMs: 5,
      isPidAlive: () => true, log: () => {},
      probeDaemon: async () => { throw new Error("handshake timeout"); },
      spawnDaemon: () => { spawns += 1; },
    }), /1234.*alive but unresponsive/);
    assert.equal(spawns, 0);
    assert.equal(await readFile(path.join(root, "port"), "utf8"), "12345\n");
    assert.equal(await readFile(path.join(root, "daemon.pid"), "utf8"), "1234\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AGE-104: an injected hung probe is bounded by the bootstrap deadline", { timeout: 3000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "age104-hung-"));
  try {
    await writeFile(path.join(root, "port"), "12345");
    await writeFile(path.join(root, "daemon.pid"), "1234");
    await assert.rejects(ensureDaemon({
      stateRoot: root, discoveryRoot: root, env: {}, timeoutMs: 50,
      isPidAlive: () => true, log: () => {},
      probeDaemon: () => new Promise(() => {}),
      spawnDaemon: () => assert.fail("must not spawn"),
    }), /alive but unresponsive/);
    assert.equal(await readFile(path.join(root, "port"), "utf8"), "12345");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AGE-104: delayed healthy hello reuses the incumbent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "age104-delayed-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const timers: ReturnType<typeof setTimeout>[] = [];
  server.on("connection", socket => {
    socket.once("message", () => {
      timers.push(setTimeout(() => socket.send(JSON.stringify(hello)), 1500));
    });
  });
  try {
    await writeFile(path.join(root, "port"), String(port));
    await writeFile(path.join(root, "daemon.pid"), "1234");
    const result = await ensureDaemon({
      stateRoot: root, discoveryRoot: root, env: {}, timeoutMs: 3000,
      isPidAlive: () => true,
      spawnDaemon: () => assert.fail("must reuse"),
    });
    assert.equal(result.spawned, false);
    assert.equal(await readFile(path.join(root, "port"), "utf8"), String(port));
  } finally {
    timers.forEach(clearTimeout);
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("AGE-104: dead refused discovery cleans up and invokes only the fake spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "age104-dead-"));
  let spawns = 0;
  try {
    await writeFile(path.join(root, "port"), "12345");
    await writeFile(path.join(root, "daemon.pid"), "1234");
    const result = await ensureDaemon({
      stateRoot: root, discoveryRoot: root, env: {}, timeoutMs: 500, retryMs: 5,
      isPidAlive: () => false,
      probeDaemon: async () => {
        if (!spawns) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        return hello;
      },
      spawnDaemon: async () => { spawns += 1; await writeFile(path.join(root, "port"), "12346"); },
    });
    assert.equal(result.spawned, true);
    assert.equal(spawns, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AGE-104: cold reads are nonblocking and coalesce with prefetch", async () => {
  let finish!: (value: Map<number, number>) => void;
  let calls = 0;
  const cache = createProcessStartIdentityCache(async () => {
    calls += 1;
    return await new Promise<Map<number, number>>(resolve => { finish = resolve; });
  });
  assert.equal(cache.read(123), null);
  assert.equal(cache.read(123), null);
  const pending = cache.prefetch([123]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish(new Map([[123, 500]]));
  await pending;
  assert.equal(cache.read(123), 500);
});

test("AGE-104: prefetch batches, expires, and refreshes reused PID identities", async () => {
  let now = 0;
  let identity = 500;
  const calls: number[][] = [];
  const cache = createProcessStartIdentityCache(async pids => {
    calls.push(pids);
    return new Map(pids.map(pid => [pid, identity]));
  }, () => now, 100);
  await cache.prefetch([1, 2, 3, 1]);
  assert.deepEqual(calls, [[1, 2, 3]]);
  assert.equal(cache.read(2), 500);
  now = 101;
  identity = 900;
  assert.equal(cache.read(2), null, "expired identity must not be used as evidence");
  await cache.prefetch([2]);
  assert.equal(cache.read(2), 900);
  identity = 1000;
  await cache.prefetch([2], true);
  assert.equal(cache.read(2), 1000);
});

test("AGE-104: failed probe is inconclusive and retries after expiry", async () => {
  let now = 0;
  let fail = true;
  const cache = createProcessStartIdentityCache(async () => {
    if (fail) throw new Error("OS unavailable");
    return new Map([[1, 500]]);
  }, () => now, 100);
  await cache.prefetch([1]);
  assert.equal(cache.read(1), null);
  fail = false;
  now = 101;
  await cache.prefetch([1]);
  assert.equal(cache.read(1), 500);
});

test("AGE-104: real session sweep prefetches all owners before classification", async () => {
  const sessions = [1, 2, 3, 4, 5].map(pid => sessionFixture({
    session_id: String(pid) as SessionId, agent: "codex" as AgentId, project: "test",
    lease_owner_process_pid: pid, lease_owner_process_registered_at: 100,
    lease_owner_process_start_time: 500,
  }));
  let warmed = false;
  const batches: number[][] = [];
  const ended: string[] = [];
  const storage = {
    listSessions: async () => sessions,
    endSessionIfUnchanged: async (id: string) => { ended.push(id); return true; },
  } as unknown as Storage;
  const counts = await runSessionEndSweep({
    storage, now: () => 100, isPidAlive: () => true,
    prefetchIdentities: async pids => { batches.push(pids); warmed = true; },
    ownerLivenessOptions: { readProcessStartEpochMs: pid => {
      assert.equal(warmed, true, "classification must follow awaited prefetch");
      return pid === 5 ? 900 : 500;
    } },
  });
  assert.deepEqual(batches, [[1, 2, 3, 4, 5]]);
  assert.deepEqual(ended, ["5"]);
  assert.equal(counts.kept_live, 4);
});

test("AGE-104: Windows batch uses one asynchronous OS call and parses per-pid identity", async () => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const cache = createProcessStartIdentityCache(pids => probeProcessIdentities(pids, "win32", async (file, args) => {
    calls += 1;
    assert.equal(file, "powershell.exe");
    assert.match(args.at(-1)!, /Get-Process -Id 1,2,3 /);
    await held;
    return "1:621355968005000000\r\n2:621355968009000000\r\n";
  }));
  const pending = cache.prefetch([1, 2, 3]);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(cache.read(1), null);
  } finally { release(); }
  await pending;
  assert.equal(cache.read(1), 500);
  assert.equal(cache.read(2), 900);
  assert.equal(cache.read(3), null);
});

test("AGE-104: registration awaits a delayed identity and persists it on the row", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "age104-register-"));
  const storage = await openSqliteStorage(path.join(root, "db.sqlite"));
  const cache = createProcessStartIdentityCache(async pids => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return new Map(pids.map(pid => [pid, 500]));
  });
  const daemon = { discoveryRoot: root, stateRoot: root, checkoutRoot: root,
    daemonBin: "test", authorityRank: "main-dev" } as DaemonSelfIdentity;
  const id = "age104-delayed-owner" as SessionId;
  try {
    await storage.upsertSession(sessionFixture({ session_id: id, agent: "claude" as AgentId, project: root }));
    const owner = await sessionLeaseOwnerWithDaemon({ process_pid: 12345 }, daemon,
      { prefetch: pids => cache.prefetch(pids), read: pid => cache.read(pid) });
    assert.equal(owner.process_start_time, 500, "bridge must await the cold probe");
    await storage.acquireSessionLease(id, "conn", Date.now(), owner);
    assert.equal((await storage.getSession(id))?.lease_owner_process_start_time, 500);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("AGE-104: self identity is pinned beyond TTL and forced prefetch", async () => {
  let now = 0;
  let calls = 0;
  const cache = createProcessStartIdentityCache(async pids => {
    calls += 1;
    return new Map(pids.map(pid => [pid, 500]));
  }, () => now, 1000, 42);
  await cache.prefetch([42]);
  assert.equal(cache.read(42), 500);
  now = 2001;
  assert.equal(cache.read(42), 500);
  await cache.prefetch([42], true);
  assert.equal(calls, 1);
});

test("AGE-104: production explicitly wires prefetch into all sweep entry points", async () => {
  const daemon = await readFile(new URL("../../core-daemon/daemon.ts", import.meta.url), "utf8");
  for (const name of ["startSessionEndSweep", "runCommLeaseSweep", "startCommLeaseSweep", "runBootScopeRestore"]) {
    assert.match(daemon, new RegExp(`${name}\\(\\{\\s*prefetchIdentities: prefetchProcessStartIdentity`));
  }
  assert.ok(daemon.indexOf("await writeDaemonDiscoveryFiles(") < daemon.indexOf("await prefetchProcessStartIdentity([process.pid])"));
});
