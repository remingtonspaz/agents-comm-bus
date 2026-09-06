import assert from "node:assert/strict";
import { constants } from "node:fs";
import { after, test } from "node:test";
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import { removeDiscoveryFilesIfOwned } from "../../core-daemon/bootstrap/daemon-retirement.js";
import { ensureDaemon } from "../../core-daemon/bootstrap/ensure-daemon.js";
import {
  claimDiscovery,
  discoveryClaimIdentityMatches,
  discoveryOwnerFile,
  readDiscoveryClaim,
  type DiscoveryClaim,
} from "../../core-daemon/bootstrap/discovery-claim.js";
import {
  discoveryGuardFile,
  discoveryReclaim2LockFile,
  discoveryReclaimLockFile,
  parseDiscoveryGuardToken,
  readDiscoveryGuardRaw,
  readDiscoveryReclaimRaw,
  resetDiscoveryGuardTestState,
  withDiscoveryGuard,
} from "../../core-daemon/bootstrap/discovery-guard.js";
import { checkDaemonPidOwnership } from "../../core-daemon/bootstrap/pid-watchdog.js";
import { IPC_PROTOCOL_VERSION, protocolMajor } from "../../core-daemon/config.js";
import { runDaemon } from "../../core-daemon/daemon.js";
import type { DaemonHello } from "../../core-daemon/ipc/protocol.js";
import { resolveDiscoveryPaths } from "../../core-daemon/paths.js";

const roots: string[] = [];
async function tempRoot(prefix = "age108-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function hello(stateRoot: string, pid = 12345): DaemonHello {
  return {
    type: "daemon.hello",
    daemonName: "agents-comm-bus",
    daemonVersion: "0.2.63",
    protocolVersion: IPC_PROTOCOL_VERSION,
    metadata: { pid, stateRoot },
  };
}

async function audits(stateRoot: string) {
  const auditDir = path.join(stateRoot, "audit");
  try {
    const files = await readdir(auditDir);
    const rows = await Promise.all(files.map(file => readFile(path.join(auditDir, file), "utf8")));
    return rows.join("\n").split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function legacyReadPortFile(portFile: string): Promise<number | undefined> {
  return readFile(portFile, "utf8").then(raw => {
    const port = Number(raw.trim());
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
  }).catch(() => undefined);
}

test("AGE-108 (a): concurrent claims elect exactly one winner without torn discovery", async () => {
  const stateRoot = await tempRoot("age108-a-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const winnerPid = 50_001;
  const winnerPort = 51_001;
  const claimants = Array.from({ length: 8 }, (_, index) => ({
    pid: winnerPid + index,
    port: 41_000 + index,
  }));

  let readerErrors: string[] = [];
  const reader = async () => {
    for (let i = 0; i < 200; i += 1) {
      const ownerRaw = await readFile(path.join(discoveryRoot, "owner.json"), "utf8").catch(() => null);
      if (ownerRaw !== null && ownerRaw.length === 0) {
        readerErrors.push("empty owner.json");
      } else if (ownerRaw) {
        try {
          JSON.parse(ownerRaw);
        } catch {
          readerErrors.push("torn owner.json");
        }
      }
      const hasPid = await access(path.join(discoveryRoot, "daemon.pid")).then(() => true).catch(() => false);
      const hasPort = await access(path.join(discoveryRoot, "port")).then(() => true).catch(() => false);
      if (hasPort && !hasPid) readerErrors.push("port without pid");
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  };

  const results = await Promise.all([
    reader(),
    ...claimants.map(claimant =>
      claimDiscovery({
        stateRoot,
        discoveryRoot,
        pid: claimant.pid,
        port: claimant.port,
        startedAt: 1_700_000_000_000 + claimant.pid,
        // Yield inside the publish step so the reader loop samples during it:
        // a non-atomic publish (create then write) exposes an empty owner.json.
        beforePublish: async () => { await new Promise(resolve => setTimeout(resolve, 30)); },
        isPidAlive: () => true,
        probeDaemon: async () => hello(stateRoot, winnerPid),
      }),
    ),
  ]);
  const claimResults = results.slice(1) as Awaited<ReturnType<typeof claimDiscovery>>[];
  const okCount = claimResults.filter(result => result.ok).length;
  const incumbentCount = claimResults.filter(result => !result.ok && result.reason === "incumbent").length;
  assert.equal(okCount, 1);
  assert.equal(incumbentCount, 7);
  assert.deepEqual(readerErrors, []);
  const owner = await readDiscoveryClaim(discoveryRoot);
  assert.ok(owner);
  assert.equal(await readFile(path.join(discoveryRoot, "daemon.pid"), "utf8"), `${owner.pid}\n`);
  assert.equal(await readFile(path.join(discoveryRoot, "port"), "utf8"), `${owner.port}\n`);
});

test("AGE-108 (b): discovery claim loser audits daemon_claim_lost without daemon_superseded", async () => {
  const stateRoot = await tempRoot("age108-b-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const wsPort = (server.address() as { port: number }).port;
  server.on("connection", socket => {
    socket.once("message", () => {
      socket.send(JSON.stringify(hello(stateRoot, process.pid)));
    });
  });

  // Cleanup runs in `finally`: a failing assertion must fail the test, never
  // keep the loopback server open and hang the runner (fix-round-2).
  try {
    const winner: DiscoveryClaim = {
      pid: process.pid,
      port: wsPort,
      stateRoot,
      startedAt: 1,
      protocolVersion: IPC_PROTOCOL_VERSION,
    };
    const ownerPath = path.join(discoveryRoot, "owner.json");
    const pidPath = path.join(discoveryRoot, "daemon.pid");
    const portPath = path.join(discoveryRoot, "port");
    const winnerOwner = `${JSON.stringify(winner)}\n`;
    const winnerPid = `${winner.pid}\n`;
    const winnerPort = `${winner.port}\n`;
    await writeFile(ownerPath, winnerOwner);
    await writeFile(pidPath, winnerPid);
    await writeFile(portPath, winnerPort);

    const exitCodes: number[] = [];
    await runDaemon({
      stateRoot,
      discoveryRoot,
      commAdapterFactories: [],
      agentBridgeFactories: [],
      exitProcess: code => {
        exitCodes.push(code);
      },
    });

    assert.deepEqual(exitCodes, [0]);
    const rows = await audits(stateRoot);
    const claimLost = rows.filter(row => row.kind === "daemon_claim_lost");
    assert.equal(claimLost.length, 1);
    assert.equal(claimLost[0].detail.winner_pid, process.pid);
    assert.equal(claimLost[0].detail.winner_port, wsPort);
    assert.equal(rows.filter(row => row.kind === "daemon_superseded").length, 0);
    assert.equal(await readFile(ownerPath, "utf8"), winnerOwner);
    assert.equal(await readFile(pidPath, "utf8"), winnerPid);
    assert.equal(await readFile(portPath, "utf8"), winnerPort);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("AGE-108 (c): foreign-root live squatter is replaced without process.kill", async () => {
  const stateRoot = await tempRoot("age108-c-");
  const foreignRoot = path.join(stateRoot, "foreign");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const squatter: DiscoveryClaim = {
    pid: 70_001,
    port: 41_003,
    stateRoot: foreignRoot,
    startedAt: 1_700_000_000_001,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(path.join(discoveryRoot, "owner.json"), `${JSON.stringify(squatter)}\n`);
  await writeFile(path.join(discoveryRoot, "daemon.pid"), `${squatter.pid}\n`);
  await writeFile(path.join(discoveryRoot, "port"), `${squatter.port}\n`);

  const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const originalKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    killCalls.push({ pid, signal: signal ?? "SIGTERM" });
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;

  const result = await claimDiscovery({
    stateRoot,
    discoveryRoot,
    pid: 70_002,
    port: 41_004,
    startedAt: 1_700_000_000_002,
    isPidAlive: pid => pid === squatter.pid,
    probeDaemon: async () => hello(foreignRoot, squatter.pid),
  });
  process.kill = originalKill;

  assert.equal(result.ok, true);
  assert.equal(killCalls.length, 0);
  const rows = await audits(stateRoot);
  const replaced = rows.filter(row => row.kind === "daemon_discovery_foreign_owner_replaced");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].detail.previous_state_root, foreignRoot);
  assert.equal(replaced[0].detail.state_root, stateRoot);

  const squatterCheck = await checkDaemonPidOwnership({
    stateRoot,
    discoveryRoot,
    pidFile: path.join(discoveryRoot, "daemon.pid"),
    port: squatter.port,
    selfPid: squatter.pid,
    selfStartedAt: squatter.startedAt,
    isPidAlive: pid => pid === squatter.pid || pid === (result.ok ? result.claim.pid : -1),
  });
  assert.equal(squatterCheck.status, "superseded");
});

test("AGE-108 (d): same-root slow incumbent stays incumbent_busy then incumbent", async () => {
  const stateRoot = await tempRoot("age108-d-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const incumbent: DiscoveryClaim = {
    pid: 80_001,
    port,
    stateRoot,
    startedAt: 1_700_000_000_003,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(path.join(discoveryRoot, "owner.json"), `${JSON.stringify(incumbent)}\n`);
  await writeFile(path.join(discoveryRoot, "daemon.pid"), `${incumbent.pid}\n`);
  await writeFile(path.join(discoveryRoot, "port"), `${incumbent.port}\n`);

  let answers = 0;
  server.on("connection", socket => {
    socket.once("message", () => {
      setTimeout(() => {
        answers += 1;
        socket.send(JSON.stringify(hello(stateRoot, incumbent.pid)));
      }, 3_000);
    });
  });

  // Cleanup in `finally` so a failing assertion cannot hang the runner.
  try {
  const busy = await claimDiscovery({
    stateRoot,
    discoveryRoot,
    pid: 80_002,
    port: port + 1,
    isPidAlive: () => true,
    probeDaemon: async () => { throw new Error("handshake timeout"); },
  });
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.reason, "incumbent_busy");

  const incumbentResult = await claimDiscovery({
    stateRoot,
    discoveryRoot,
    pid: 80_002,
    port: port + 1,
    isPidAlive: () => true,
    probeDaemon: async () => hello(stateRoot, incumbent.pid),
  });
  assert.equal(incumbentResult.ok, false);
  if (!incumbentResult.ok) assert.equal(incumbentResult.reason, "incumbent");

  const reused = await ensureDaemon({
    stateRoot,
    discoveryRoot,
    env: {},
    timeoutMs: 8_000,
    retryMs: 50,
    isPidAlive: () => true,
    spawnDaemon: () => assert.fail("must reuse slow incumbent"),
  });
  assert.equal(reused.spawned, false);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("AGE-108 (e): watchdog identity requires matching startedAt when present", async () => {
  const stateRoot = await tempRoot("age108-e-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const selfPid = 90_001;
  const selfStartedAt = 1_700_000_000_004;
  const owner: DiscoveryClaim = {
    pid: selfPid,
    port: 41_005,
    stateRoot,
    startedAt: selfStartedAt + 1,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(path.join(discoveryRoot, "owner.json"), `${JSON.stringify(owner)}\n`);

  const mismatch = await checkDaemonPidOwnership({
    stateRoot,
    discoveryRoot,
    pidFile: path.join(discoveryRoot, "daemon.pid"),
    port: owner.port,
    selfPid,
    selfStartedAt,
    isPidAlive: () => true,
  });
  assert.equal(mismatch.status, "superseded");

  owner.startedAt = selfStartedAt;
  await writeFile(path.join(discoveryRoot, "owner.json"), `${JSON.stringify(owner)}\n`);
  const current = await checkDaemonPidOwnership({
    stateRoot,
    discoveryRoot,
    pidFile: path.join(discoveryRoot, "daemon.pid"),
    port: owner.port,
    selfPid,
    selfStartedAt,
    isPidAlive: () => true,
  });
  assert.equal(current.status, "current");
  assert.equal(discoveryClaimIdentityMatches(owner, selfPid, selfStartedAt), true);
});

test("AGE-108 (f): derived legacy port and pid files match pre-change reader format", async () => {
  const stateRoot = await tempRoot("age108-f-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  const port = 41_006;
  const result = await claimDiscovery({
    stateRoot,
    discoveryRoot,
    pid: 90_002,
    port,
    startedAt: 1_700_000_000_005,
    isPidAlive: () => false,
    probeDaemon: async () => hello(stateRoot),
  });
  assert.equal(result.ok, true);
  const paths = resolveDiscoveryPaths({ stateRoot, discoveryRoot });
  assert.equal(await readFile(paths.pidFile, "utf8"), "90002\n");
  assert.equal(await readFile(paths.portFile, "utf8"), `${port}\n`);
  assert.equal(await legacyReadPortFile(paths.portFile), port);
});

test("AGE-108 (g): legacy pid/port only discovery converts to owner.json with stale audit", async () => {
  const stateRoot = await tempRoot("age108-g-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const paths = resolveDiscoveryPaths({ stateRoot, discoveryRoot });
  await writeFile(paths.pidFile, "41001\n");
  await writeFile(paths.portFile, "41002\n");
  const result = await claimDiscovery({
    stateRoot,
    discoveryRoot,
    pid: 41_003,
    port: 41_007,
    startedAt: 1_700_000_000_006,
    isPidAlive: () => false,
    probeDaemon: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
  });
  assert.equal(result.ok, true);
  const owner = await readDiscoveryClaim(discoveryRoot);
  assert.ok(owner);
  assert.equal(owner.pid, 41_003);
  const rows = await audits(stateRoot);
  assert.equal(rows.filter(row => row.kind === "discovery_stale_cleanup").length, 1);
});

async function publishBarrier(count: number): Promise<() => Promise<void>> {
  let arrived = 0;
  const waiters: Array<() => void> = [];
  return async () => {
    arrived += 1;
    if (arrived < count) {
      await new Promise<void>(resolve => waiters.push(resolve));
    } else {
      for (const release of waiters) release();
    }
  };
}

test("AGE-108 (h): dead-owner concurrent claims elect one winner under discovery guard", async () => {
  const stateRoot = await tempRoot("age108-h-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const dead: DiscoveryClaim = {
    pid: 60_001,
    port: 41_010,
    stateRoot,
    startedAt: 1,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(dead)}\n`);
  const [first, second] = await Promise.all([
    claimDiscovery({
      stateRoot,
      discoveryRoot,
      pid: 60_002,
      port: 41_011,
      startedAt: 2,
      isPidAlive: pid => pid !== dead.pid,
      probeDaemon: async () => hello(stateRoot, 60_002),
    }),
    claimDiscovery({
      stateRoot,
      discoveryRoot,
      pid: 60_003,
      port: 41_012,
      startedAt: 3,
      isPidAlive: pid => pid !== dead.pid,
      probeDaemon: async () => hello(stateRoot, 60_002),
    }),
  ]);
  const okCount = [first, second].filter(result => result.ok).length;
  const incumbentCount = [first, second].filter(result => !result.ok && result.reason === "incumbent").length;
  assert.equal(okCount, 1);
  assert.equal(incumbentCount, 1);
  const winner = first.ok ? first : second.ok ? second : undefined;
  assert.ok(winner?.ok);
  const owner = await readDiscoveryClaim(discoveryRoot);
  assert.ok(owner);
  assert.equal(await readFile(path.join(discoveryRoot, "daemon.pid"), "utf8"), `${owner.pid}\n`);
  assert.equal(await readFile(path.join(discoveryRoot, "port"), "utf8"), `${owner.port}\n`);
  const entries = await readdir(discoveryRoot);
  assert.equal(entries.some(name => name.includes(".tmp.")), false);
});

test("AGE-108 (i): claimDiscovery succeeds while spawn lock is held by parent", async () => {
  const stateRoot = await tempRoot("age108-i-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  const paths = resolveDiscoveryPaths({ stateRoot, discoveryRoot });
  await mkdir(discoveryRoot, { recursive: true });
  const lockHandle = await open(paths.spawnLock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  await lockHandle.writeFile(`${process.pid}:${Date.now()}\n`, "utf8");
  await lockHandle.close();
  try {
    const result = await claimDiscovery({
      stateRoot,
      discoveryRoot,
      pid: 61_001,
      port: 41_013,
      startedAt: 1_700_000_000_010,
      isPidAlive: () => false,
      probeDaemon: async () => hello(stateRoot),
    });
    assert.equal(result.ok, true);
  } finally {
    await rm(paths.spawnLock, { force: true });
  }
});

test("AGE-108 (j): empty owner.json is replaced with invalid_owner_record audit", async () => {
  const stateRoot = await tempRoot("age108-j-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  await writeFile(discoveryOwnerFile(discoveryRoot), "");
  const result = await claimDiscovery({
    stateRoot,
    discoveryRoot,
    pid: 62_001,
    port: 41_014,
    startedAt: 1_700_000_000_011,
    isPidAlive: () => false,
    probeDaemon: async () => hello(stateRoot),
  });
  assert.equal(result.ok, true);
  const owner = await readDiscoveryClaim(discoveryRoot);
  assert.ok(owner);
  const rows = await audits(stateRoot);
  const cleaned = rows.filter(row => row.kind === "discovery_stale_cleanup");
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].detail.reason, "invalid_owner_record");
});

test("AGE-108 (k): retirement honors authoritative owner.json over legacy pid/port", async () => {
  const stateRoot = await tempRoot("age108-k-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  const paths = resolveDiscoveryPaths({ stateRoot, discoveryRoot });
  await mkdir(discoveryRoot, { recursive: true });
  const selfPid = 63_001;
  const selfPort = 41_015;
  const selfStartedAt = 1_700_000_000_012;
  const successorPid = 63_002;
  const owner: DiscoveryClaim = {
    pid: successorPid,
    port: selfPort,
    stateRoot,
    startedAt: 1_700_000_000_099,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(paths.pidFile, `${selfPid}\n`);
  await writeFile(paths.portFile, `${selfPort}\n`);
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(owner)}\n`);

  assert.equal(
    await removeDiscoveryFilesIfOwned({
      discoveryRoot,
      selfPid,
      selfPort,
      selfStartedAt,
      isPidAlive: pid => pid === successorPid,
    }),
    false,
  );
  assert.equal(await readFile(paths.pidFile, "utf8"), `${selfPid}\n`);
  assert.equal(await readFile(paths.portFile, "utf8"), `${selfPort}\n`);
  assert.equal(await readFile(discoveryOwnerFile(discoveryRoot), "utf8"), `${JSON.stringify(owner)}\n`);

  const selfOwner: DiscoveryClaim = {
    pid: selfPid,
    port: selfPort,
    stateRoot,
    startedAt: selfStartedAt,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(selfOwner)}\n`);
  assert.equal(
    await removeDiscoveryFilesIfOwned({
      discoveryRoot,
      selfPid,
      selfPort,
      selfStartedAt,
    }),
    true,
  );
  await assert.rejects(() => readFile(paths.pidFile, "utf8"));
  await assert.rejects(() => readFile(paths.portFile, "utf8"));
  await assert.rejects(() => readFile(discoveryOwnerFile(discoveryRoot), "utf8"));

  await writeFile(paths.pidFile, `${selfPid}\n`);
  await writeFile(paths.portFile, `${selfPort}\n`);
  const mismatchedStartedAt = { ...selfOwner, startedAt: selfStartedAt + 1 };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(mismatchedStartedAt)}\n`);
  assert.equal(
    await removeDiscoveryFilesIfOwned({
      discoveryRoot,
      selfPid,
      selfPort,
      selfStartedAt,
    }),
    false,
  );
});

test("AGE-108 (l): retirement does not delete files while replacement holds guard", async () => {
  const stateRoot = await tempRoot("age108-l-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  const paths = resolveDiscoveryPaths({ stateRoot, discoveryRoot });
  await mkdir(discoveryRoot, { recursive: true });
  const predecessorPid = 64_001;
  const predecessorPort = 41_016;
  const predecessorStartedAt = 1_700_000_000_013;
  const dead: DiscoveryClaim = {
    pid: predecessorPid,
    port: predecessorPort,
    stateRoot,
    startedAt: predecessorStartedAt,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(dead)}\n`);
  await writeFile(paths.pidFile, `${predecessorPid}\n`);
  await writeFile(paths.portFile, `${predecessorPort}\n`);

  let holdGuard: (() => void) | undefined;
  let signalGuardHeld: (() => void) | undefined;
  const guardHeld = new Promise<void>(resolve => {
    signalGuardHeld = resolve;
  });
  const beforePublish = async () => {
    signalGuardHeld?.();
    await new Promise<void>(resolve => {
      holdGuard = resolve;
    });
  };

  const successor = claimDiscovery({
    stateRoot,
    discoveryRoot,
    pid: 64_002,
    port: 41_017,
    startedAt: 1_700_000_000_014,
    beforePublish,
    isPidAlive: pid => pid !== predecessorPid,
    probeDaemon: async () => hello(stateRoot),
  });

  await guardHeld;
  const removed = await removeDiscoveryFilesIfOwned({
    discoveryRoot,
    selfPid: predecessorPid,
    selfPort: predecessorPort,
    selfStartedAt: predecessorStartedAt,
    guardTimeoutMs: 100,
    isPidAlive: pid => pid === 64_002,
  });
  assert.equal(removed, false);
  holdGuard?.();
  const claimed = await successor;
  assert.equal(claimed.ok, true);
  assert.equal(await readFile(discoveryOwnerFile(discoveryRoot), "utf8").then(raw => JSON.parse(raw).pid), 64_002);
});

test("AGE-108 (m): ensureDaemon gates on claim pid when probe times out", async () => {
  const stateRoot = await tempRoot("age108-m-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const claimPid = 65_001;
  const claim: DiscoveryClaim = {
    pid: claimPid,
    port: 41_018,
    stateRoot,
    startedAt: 1_700_000_000_015,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(claim)}\n`);

  await assert.rejects(
    () =>
      ensureDaemon({
        stateRoot,
        discoveryRoot,
        env: {},
        timeoutMs: 300,
        retryMs: 20,
        isPidAlive: pid => pid === claimPid,
        probeDaemon: async () => {
          await new Promise(resolve => setTimeout(resolve, 500));
          return hello(stateRoot, claimPid);
        },
        spawnDaemon: () => assert.fail("must not spawn while claim pid is alive"),
      }),
    (error: Error) => error.message.includes(`Daemon pid ${claimPid}`),
  );
});

test("AGE-108 (n): terminateDaemon uses hello metadata pid, not daemon.pid", async () => {
  const stateRoot = await tempRoot("age108-n-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const claimPid = 66_001;
  const unrelatedPid = 66_002;
  const port = 41_019;
  const claim: DiscoveryClaim = {
    pid: claimPid,
    port,
    stateRoot,
    startedAt: 1_700_000_000_016,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(claim)}\n`);
  await writeFile(path.join(discoveryRoot, "daemon.pid"), `${unrelatedPid}\n`);
  await writeFile(path.join(discoveryRoot, "port"), `${port}\n`);

  const olderMajor = `${Number(protocolMajor(IPC_PROTOCOL_VERSION)) - 1}.0.0`;
  const terminated: number[] = [];
  let claimMarkedDead = false;
  await ensureDaemon({
    stateRoot,
    discoveryRoot,
    env: {},
    protocolVersion: IPC_PROTOCOL_VERSION,
    timeoutMs: 2_000,
    retryMs: 20,
    isPidAlive: pid => {
      if (pid === claimPid) return !claimMarkedDead;
      return pid === unrelatedPid;
    },
    probeDaemon: async () => ({
      ...hello(stateRoot, claimPid),
      protocolVersion: olderMajor,
      metadata: { pid: claimPid, stateRoot },
    }),
    terminateDaemon: pid => {
      terminated.push(pid);
      claimMarkedDead = true;
    },
    spawnDaemon: () => undefined,
  }).catch(() => undefined);
  assert.deepEqual(terminated, [claimPid]);

  const stateRoot2 = await tempRoot("age108-n2-");
  const discoveryRoot2 = path.join(stateRoot2, "discovery");
  await mkdir(discoveryRoot2, { recursive: true });
  const claim2: DiscoveryClaim = {
    ...claim,
    stateRoot: stateRoot2,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot2), `${JSON.stringify(claim2)}\n`);
  await writeFile(path.join(discoveryRoot2, "daemon.pid"), `${unrelatedPid}\n`);
  await writeFile(path.join(discoveryRoot2, "port"), `${port}\n`);
  const terminated2: number[] = [];
  await ensureDaemon({
    stateRoot: stateRoot2,
    discoveryRoot: discoveryRoot2,
    env: {},
    protocolVersion: IPC_PROTOCOL_VERSION,
    timeoutMs: 2_000,
    retryMs: 20,
    isPidAlive: pid => pid === claimPid || pid === unrelatedPid,
    probeDaemon: async () => ({
      ...hello(stateRoot2, claimPid),
      protocolVersion: olderMajor,
      metadata: { stateRoot: stateRoot2 },
    }),
    terminateDaemon: pid => {
      terminated2.push(pid);
    },
    spawnDaemon: () => undefined,
  }).catch(() => undefined);
  assert.deepEqual(terminated2, []);
  const rows = await audits(stateRoot2);
  assert.equal(rows.filter(row => row.kind === "daemon_terminate_skipped_identity_unknown").length, 1);
});

test("AGE-108 (o): guard token race elects exactly one holder", async () => {
  const stateRoot = await tempRoot("age108-o-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  let releaseHolder: (() => void) | undefined;
  let guardAcquired: (() => void) | undefined;
  const acquired = new Promise<void>(resolve => {
    guardAcquired = resolve;
  });
  const guardSamples: string[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const raw = await readDiscoveryGuardRaw(discoveryRoot);
      if (raw !== null) guardSamples.push(raw);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  })();
  const holder = withDiscoveryGuard(
    discoveryRoot,
    { pid: 67_001, startedAt: 1 },
    async () => {
      guardAcquired?.();
      await new Promise<void>(resolve => {
        releaseHolder = resolve;
      });
      return "held";
    },
    {
      maxWaitMs: 2_000,
      isPidAlive: () => true,
      // Pause inside the token publish: a create-then-write publish would leave an
      // empty owner.lock visible to the sampler during this window.
      beforeGuardLink: async () => { await new Promise(resolve => setTimeout(resolve, 40)); },
    },
  );
  await acquired;
  sampling = false;
  await sampler;
  assert.ok(guardSamples.length >= 0);
  assert.equal(guardSamples.filter(raw => raw.length === 0 || parseDiscoveryGuardToken(raw) === undefined).length, 0,
    "owner.lock must never be observed empty or unparsable while being published");
  const waiter = await withDiscoveryGuard(
    discoveryRoot,
    { pid: 67_002, startedAt: 2 },
    async () => "waiter",
    { maxWaitMs: 100, isPidAlive: () => true },
  );
  releaseHolder?.();
  const held = await holder;
  assert.equal(held.ok, true);
  assert.equal(waiter.ok, false);
  if (!waiter.ok) assert.equal(waiter.reason, "guard_contended");
});

test("AGE-108 (p): unparsable owner.lock is never stolen and yields guard_contended", async () => {
  const stateRoot = await tempRoot("age108-p-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  await writeFile(discoveryGuardFile(discoveryRoot), "");
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(discoveryGuardFile(discoveryRoot), old, old);
  const result = await withDiscoveryGuard(
    discoveryRoot,
    { pid: 68_001, startedAt: 1 },
    async () => "never",
    { maxWaitMs: 100, isPidAlive: () => false },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "guard_contended");
  assert.equal(await readDiscoveryGuardRaw(discoveryRoot), "");
});

test("AGE-108 (q): dead-guard reclaim preserves a successor token published in between", async () => {
  const stateRoot = await tempRoot("age108-q-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const deadToken = { pid: 69_001, startedAt: 1, at: Date.now() - 60_000, nonce: "dead-guard-q" };
  await writeFile(discoveryGuardFile(discoveryRoot), `${JSON.stringify(deadToken)}\n`);

  let releaseReclaim: (() => void) | undefined;
  const beforeReclaim = async () => {
    await new Promise<void>(resolve => {
      releaseReclaim = resolve;
    });
  };

  const reclaimB = withDiscoveryGuard(
    discoveryRoot,
    { pid: 69_003, startedAt: 3 },
    async () => "b",
    { maxWaitMs: 5_000, isPidAlive: pid => pid === 69_002, beforeReclaim },
  );

  await new Promise(resolve => setTimeout(resolve, 30));
  const reclaimA = await withDiscoveryGuard(
    discoveryRoot,
    { pid: 69_002, startedAt: 2 },
    async () => "a",
    { maxWaitMs: 5_000, isPidAlive: () => false },
  );
  assert.equal(reclaimA.ok, true);

  const liveY = { pid: 69_004, startedAt: 4, at: Date.now(), nonce: "live-guard-y" };
  await writeFile(discoveryGuardFile(discoveryRoot), `${JSON.stringify(liveY)}\n`);
  releaseReclaim?.();
  const reclaimBResult = await reclaimB;
  assert.equal(reclaimBResult.ok, false);
  if (!reclaimBResult.ok) assert.equal(reclaimBResult.reason, "guard_contended");

  const samples: Array<string | null> = [];
  for (let i = 0; i < 20; i += 1) {
    samples.push(await readDiscoveryGuardRaw(discoveryRoot));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(samples.every(raw => raw === `${JSON.stringify(liveY)}\n`), true);
  const parsed = parseDiscoveryGuardToken(samples[0] ?? "");
  assert.ok(parsed);
  assert.equal(parsed.pid, liveY.pid);
});

test("AGE-108 (r): claim generation change cancels terminateDaemon", async () => {
  const stateRoot = await tempRoot("age108-r-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const claimPid = 70_010;
  const port = 41_020;
  const original: DiscoveryClaim = {
    pid: claimPid,
    port,
    stateRoot,
    startedAt: 1_700_000_000_020,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(original)}\n`);
  await writeFile(path.join(discoveryRoot, "daemon.pid"), `${claimPid}\n`);
  await writeFile(path.join(discoveryRoot, "port"), `${port}\n`);

  const olderMajor = `${Number(protocolMajor(IPC_PROTOCOL_VERSION)) - 1}.0.0`;
  const terminated: number[] = [];
  await ensureDaemon({
    stateRoot,
    discoveryRoot,
    env: {},
    protocolVersion: IPC_PROTOCOL_VERSION,
    timeoutMs: 1_000,
    retryMs: 20,
    isPidAlive: pid => pid === claimPid,
    probeDaemon: async () => {
      const changed: DiscoveryClaim = {
        ...original,
        startedAt: original.startedAt! + 1,
      };
      await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(changed)}\n`);
      return {
        ...hello(stateRoot, claimPid),
        protocolVersion: olderMajor,
        metadata: { pid: claimPid, stateRoot },
      };
    },
    terminateDaemon: pid => {
      terminated.push(pid);
    },
    spawnDaemon: () => undefined,
  }).catch(() => undefined);
  assert.deepEqual(terminated, []);
  const rows = await audits(stateRoot);
  assert.equal(rows.filter(row => row.kind === "daemon_terminate_skipped_identity_unknown").length, 1);
  assert.equal(rows.find(row => row.kind === "daemon_terminate_skipped_identity_unknown")?.detail.reason, "claim_changed");
});

test("AGE-108 (s): dead reclaim recovery preserves a successor reclaim token published in between", async () => {
  resetDiscoveryGuardTestState();
  const stateRoot = await tempRoot("age108-s-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const deadGuard = { pid: 71_001, startedAt: 1, at: Date.now() - 60_000, nonce: "dead-guard-s" };
  const deadReclaimX = { pid: 71_002, startedAt: 2, at: Date.now() - 60_000, nonce: "dead-reclaim-x" };
  await writeFile(discoveryGuardFile(discoveryRoot), `${JSON.stringify(deadGuard)}\n`);
  await writeFile(discoveryReclaimLockFile(discoveryRoot), `${JSON.stringify(deadReclaimX)}\n`);

  let releaseReclaim2: (() => void) | undefined;
  const beforeReclaim2 = async () => {
    await new Promise<void>(resolve => {
      releaseReclaim2 = resolve;
    });
  };
  let releaseQuarantine: (() => void) | undefined;
  const beforeQuarantine = async () => {
    await new Promise<void>(resolve => {
      releaseQuarantine = resolve;
    });
  };

  const reclaimSamples: Array<string | null> = [];
  let sampling = false;
  let samplerDone: Promise<void> | undefined;
  const startSampler = () => {
    sampling = true;
    samplerDone = (async () => {
      while (sampling) {
        reclaimSamples.push(await readDiscoveryReclaimRaw(discoveryRoot));
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    })();
  };

  const reclaimB = withDiscoveryGuard(
    discoveryRoot,
    { pid: 71_003, startedAt: 3 },
    async () => "b",
    { maxWaitMs: 5_000, isPidAlive: pid => pid === 71_004, beforeReclaim2 },
  );

  await new Promise(resolve => setTimeout(resolve, 30));
  const reclaimA = withDiscoveryGuard(
    discoveryRoot,
    { pid: 71_004, startedAt: 4 },
    async () => "a",
    { maxWaitMs: 5_000, isPidAlive: () => false, beforeQuarantine },
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  const expectedY = await readDiscoveryReclaimRaw(discoveryRoot);
  assert.ok(expectedY);
  startSampler();
  releaseReclaim2?.();
  const reclaimBResult = await reclaimB;
  assert.equal(reclaimBResult.ok, false);
  if (!reclaimBResult.ok) assert.equal(reclaimBResult.reason, "guard_contended");
  sampling = false;
  await samplerDone;
  assert.equal(
    reclaimSamples.filter(raw => raw !== expectedY).length,
    0,
    "owner.lock.reclaim must equal the successor reclaim token at every sample",
  );
  releaseQuarantine?.();
  const reclaimAResult = await reclaimA;
  assert.equal(reclaimAResult.ok, true);

  const reclaimY = parseDiscoveryGuardToken(expectedY);
  assert.ok(reclaimY);
  assert.equal(reclaimY.pid, 71_004);
});

test("AGE-108 (t): dead owner.lock.reclaim2 yields guard_contended without auto-reap", async () => {
  resetDiscoveryGuardTestState();
  const stateRoot = await tempRoot("age108-t-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const deadReclaim2 = { pid: 72_001, startedAt: 1, at: Date.now() - 60_000, nonce: "dead-reclaim2" };
  const deadGuard = { pid: 72_002, startedAt: 2, at: Date.now() - 60_000, nonce: "dead-guard-t" };
  const reclaim2Path = discoveryReclaim2LockFile(discoveryRoot);
  await writeFile(reclaim2Path, `${JSON.stringify(deadReclaim2)}\n`);
  await writeFile(discoveryGuardFile(discoveryRoot), `${JSON.stringify(deadGuard)}\n`);
  const before = await readFile(reclaim2Path, "utf8");
  const result = await withDiscoveryGuard(
    discoveryRoot,
    { pid: 72_003, startedAt: 3 },
    async () => "never",
    { maxWaitMs: 100, isPidAlive: () => false },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "guard_contended");
  assert.equal(await readFile(reclaim2Path, "utf8"), before);
});

test("AGE-108 (u): same-pid overlapping guards exclude via nonce and exclusive temps", async () => {
  const stateRoot = await tempRoot("age108-u-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const sharedPid = process.pid;
  let nowValue = 1_700_000_000_100;
  const now = () => nowValue;
  let concurrent = 0;
  let maxConcurrent = 0;
  let holderBytes: string | null = null;

  const runGuard = async (startedAt: number) =>
    withDiscoveryGuard(
      discoveryRoot,
      { pid: sharedPid, startedAt },
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        holderBytes = await readDiscoveryGuardRaw(discoveryRoot);
        assert.ok(holderBytes && holderBytes.length > 0);
        await new Promise(resolve => setTimeout(resolve, 40));
        const during = await readDiscoveryGuardRaw(discoveryRoot);
        assert.equal(during, holderBytes, "owner.lock bytes must stay complete and unchanged for the holder");
        concurrent -= 1;
        return startedAt;
      },
      { maxWaitMs: 500, now, isPidAlive: () => true },
    );

  const first = runGuard(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = runGuard(2);
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(maxConcurrent, 1, "guard callbacks must not overlap");
  assert.equal([r1.ok, r2.ok].every(Boolean), true, "both guards should eventually succeed when serialized");
  const files = await readdir(discoveryRoot);
  assert.equal(files.some(name => name.includes(".tmp.")), false, "no temp files must remain");
});

test("AGE-108 (v): claim disappearance between probe and terminate cancels termination", async () => {
  const stateRoot = await tempRoot("age108-v-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const claimPid = 73_010;
  const port = 41_030;
  const original: DiscoveryClaim = {
    pid: claimPid,
    port,
    stateRoot,
    startedAt: 1_700_000_000_030,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(original)}\n`);
  await writeFile(path.join(discoveryRoot, "daemon.pid"), `${claimPid}\n`);
  await writeFile(path.join(discoveryRoot, "port"), `${port}\n`);

  const olderMajor = `${Number(protocolMajor(IPC_PROTOCOL_VERSION)) - 1}.0.0`;
  const terminated: number[] = [];
  await ensureDaemon({
    stateRoot,
    discoveryRoot,
    env: {},
    protocolVersion: IPC_PROTOCOL_VERSION,
    timeoutMs: 1_000,
    retryMs: 20,
    isPidAlive: pid => pid === claimPid,
    probeDaemon: async () => {
      await rm(discoveryOwnerFile(discoveryRoot), { force: true });
      return {
        ...hello(stateRoot, claimPid),
        protocolVersion: olderMajor,
        metadata: { pid: claimPid, stateRoot },
      };
    },
    terminateDaemon: pid => {
      terminated.push(pid);
    },
    spawnDaemon: () => undefined,
  }).catch(() => undefined);
  assert.deepEqual(terminated, []);
  const rows = await audits(stateRoot);
  assert.equal(rows.filter(row => row.kind === "daemon_terminate_skipped_identity_unknown").length, 1);
  assert.equal(
    rows.find(row => row.kind === "daemon_terminate_skipped_identity_unknown")?.detail.reason,
    "claim_changed",
  );
});

test("AGE-108 (w): post-termination cleanup leaves a successor claim intact", async () => {
  const stateRoot = await tempRoot("age108-w-");
  const discoveryRoot = path.join(stateRoot, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const claimPid = 74_010;
  const successorPid = 74_011;
  const port = 41_031;
  const successorPort = 41_032;
  const original: DiscoveryClaim = {
    pid: claimPid,
    port,
    stateRoot,
    startedAt: 1_700_000_000_031,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
  const successor: DiscoveryClaim = {
    pid: successorPid,
    port: successorPort,
    stateRoot,
    startedAt: 1_700_000_000_032,
    protocolVersion: IPC_PROTOCOL_VERSION,
    nonce: "successor-w",
  };
  const ownerBytes = `${JSON.stringify(original)}\n`;
  const pidBytes = `${claimPid}\n`;
  const portBytes = `${port}\n`;
  await writeFile(discoveryOwnerFile(discoveryRoot), ownerBytes);
  await writeFile(path.join(discoveryRoot, "daemon.pid"), pidBytes);
  await writeFile(path.join(discoveryRoot, "port"), portBytes);

  const successorOwnerBytes = `${JSON.stringify(successor)}\n`;
  const successorPidBytes = `${successorPid}\n`;
  const successorPortBytes = `${successorPort}\n`;

  const olderMajor = `${Number(protocolMajor(IPC_PROTOCOL_VERSION)) - 1}.0.0`;
  let claimMarkedDead = false;
  await ensureDaemon({
    stateRoot,
    discoveryRoot,
    env: {},
    protocolVersion: IPC_PROTOCOL_VERSION,
    timeoutMs: 2_000,
    retryMs: 20,
    isPidAlive: pid => {
      if (pid === claimPid) return !claimMarkedDead;
      return pid === successorPid;
    },
    probeDaemon: async () => ({
      ...hello(stateRoot, claimPid),
      protocolVersion: olderMajor,
      metadata: { pid: claimPid, stateRoot },
    }),
    terminateDaemon: async () => {
      claimMarkedDead = true;
      await writeFile(discoveryOwnerFile(discoveryRoot), successorOwnerBytes);
      await writeFile(path.join(discoveryRoot, "daemon.pid"), successorPidBytes);
      await writeFile(path.join(discoveryRoot, "port"), successorPortBytes);
    },
    spawnDaemon: () => undefined,
  }).catch(() => undefined);

  assert.equal(await readFile(discoveryOwnerFile(discoveryRoot), "utf8"), successorOwnerBytes);
  assert.equal(await readFile(path.join(discoveryRoot, "daemon.pid"), "utf8"), successorPidBytes);
  assert.equal(await readFile(path.join(discoveryRoot, "port"), "utf8"), successorPortBytes);
});
