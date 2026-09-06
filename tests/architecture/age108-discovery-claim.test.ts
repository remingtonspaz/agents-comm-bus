import assert from "node:assert/strict";
import { after, test } from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import { ensureDaemon } from "../../core-daemon/bootstrap/ensure-daemon.js";
import {
  claimDiscovery,
  discoveryClaimIdentityMatches,
  readDiscoveryClaim,
  type DiscoveryClaim,
} from "../../core-daemon/bootstrap/discovery-claim.js";
import { checkDaemonPidOwnership } from "../../core-daemon/bootstrap/pid-watchdog.js";
import { IPC_PROTOCOL_VERSION } from "../../core-daemon/config.js";
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
      if (ownerRaw) {
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

  let barrierArrived = 0;
  const barrierWaiters: Array<() => void> = [];
  const beforeCreate = async () => {
    barrierArrived += 1;
    if (barrierArrived < claimants.length) {
      await new Promise<void>(resolve => barrierWaiters.push(resolve));
    } else {
      for (const release of barrierWaiters) release();
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
        acquireLock: async () => undefined,
        beforeCreate,
        isPidAlive: () => true,
        probeDaemon: async (probePort) => hello(stateRoot, winnerPid),
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

  for (const client of server.clients) client.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
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
  for (const client of server.clients) client.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
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
