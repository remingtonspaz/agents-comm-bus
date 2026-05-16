import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureDaemon, writeDaemonDiscoveryFiles } from "../../agents-comm-bus/src/bootstrap/ensure-daemon.js";
import { DAEMON_VERSION, IPC_PROTOCOL_VERSION } from "../../agents-comm-bus/src/config.js";
import { resolveConversationPaths, resolveStatePaths } from "../../agents-comm-bus/src/paths.js";
import type { DaemonHello } from "../../agents-comm-bus/src/ipc/protocol.js";

function daemonHello(): DaemonHello {
  return {
    type: "daemon.hello",
    protocolVersion: IPC_PROTOCOL_VERSION,
    daemonVersion: DAEMON_VERSION,
    daemonName: "agents-comm-bus",
    metadata: { test: true },
  };
}

async function tempStateRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agents-comm-bus-test-"));
}

describe("agents-comm-bus path layout", () => {
  it("resolves canonical durable paths under ~/.agents-comm-bus", () => {
    const homeDir = path.join(os.tmpdir(), "home-a");
    const paths = resolveStatePaths({ homeDir });

    assert.equal(paths.root, path.join(homeDir, ".agents-comm-bus"));
    assert.equal(paths.database, path.join(paths.root, "agents-comm-bus.db"));
    assert.equal(paths.databaseWal, path.join(paths.root, "agents-comm-bus.db-wal"));
    assert.equal(paths.databaseShm, path.join(paths.root, "agents-comm-bus.db-shm"));
    assert.equal(paths.auditDir, path.join(paths.root, "audit"));
    assert.equal(paths.chatsDir, path.join(paths.root, "chats"));
    assert.equal(paths.pidFile, path.join(paths.root, "daemon.pid"));
    assert.equal(paths.portFile, path.join(paths.root, "port"));
    assert.equal(paths.spawnLock, path.join(paths.root, ".spawn.lock"));
  });

  it("resolves transcript and attachment paths per conversation inventory id", () => {
    const stateRoot = path.join(os.tmpdir(), "state-root");
    const paths = resolveConversationPaths({ stateRoot, conversationId: "project/chat 1" });
    const conversationDir = path.join(stateRoot, "chats", "project%2Fchat%201");

    assert.equal(paths.conversationDir, conversationDir);
    assert.equal(paths.transcript, path.join(conversationDir, "transcript.jsonl"));
    assert.equal(paths.attachmentsDir, path.join(conversationDir, "attachments"));
  });
});

describe("ensureDaemon", () => {
  it("converges concurrent callers on one spawned daemon", async () => {
    const stateRoot = await tempStateRoot();
    let spawnCount = 0;
    const port = 41_111;

    const spawnDaemon = async (): Promise<void> => {
      spawnCount += 1;
      await writeDaemonDiscoveryFiles({ stateRoot, pid: process.pid, port });
    };

    const probeDaemon = async (candidatePort: number): Promise<DaemonHello> => {
      assert.equal(candidatePort, port);
      return daemonHello();
    };

    const [a, b] = await Promise.all([
      ensureDaemon({ stateRoot, spawnDaemon, probeDaemon, timeoutMs: 1_000, retryMs: 5 }),
      ensureDaemon({ stateRoot, spawnDaemon, probeDaemon, timeoutMs: 1_000, retryMs: 5 }),
    ]);

    assert.equal(spawnCount, 1);
    assert.equal(a.port, port);
    assert.equal(b.port, port);
    assert.equal(a.hello.protocolVersion, IPC_PROTOCOL_VERSION);
    assert.equal(b.hello.protocolVersion, IPC_PROTOCOL_VERSION);
  });

  it("removes stale pid and port files before spawning", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidFile, "99999999\n", "utf8");
    await writeFile(paths.portFile, "49999\n", "utf8");

    let probedStalePort = false;
    let spawned = false;
    const port = 41_112;

    const result = await ensureDaemon({
      stateRoot,
      isPidAlive: () => false,
      probeDaemon: async (candidatePort) => {
        if (candidatePort === 49_999) {
          probedStalePort = true;
          throw new Error("stale port");
        }
        assert.equal(candidatePort, port);
        return daemonHello();
      },
      spawnDaemon: async () => {
        spawned = true;
        await writeDaemonDiscoveryFiles({ stateRoot, pid: process.pid, port });
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.equal(probedStalePort, true);
    assert.equal(spawned, true);
    assert.equal(result.port, port);
    assert.equal((await readFile(paths.portFile, "utf8")).trim(), String(port));
  });

  it("terminates and replaces a daemon with an older daemon version", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidFile, "12345\n", "utf8");
    await writeFile(paths.portFile, "41117\n", "utf8");

    let oldPidAlive = true;
    let terminatedPid: number | undefined;
    let spawned = false;
    const newPort = 41_118;

    const result = await ensureDaemon({
      stateRoot,
      desiredDaemonVersion: DAEMON_VERSION,
      isPidAlive: (pid) => pid === 12_345 && oldPidAlive,
      terminateDaemon: (pid) => {
        terminatedPid = pid;
        oldPidAlive = false;
      },
      probeDaemon: async (candidatePort) => {
        if (candidatePort === 41_117) {
          return { ...daemonHello(), daemonVersion: "0.0.1" };
        }
        assert.equal(candidatePort, newPort);
        return daemonHello();
      },
      spawnDaemon: async () => {
        spawned = true;
        await writeDaemonDiscoveryFiles({ stateRoot, pid: process.pid, port: newPort });
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.equal(terminatedPid, 12_345);
    assert.equal(spawned, true);
    assert.equal(result.spawned, true);
    assert.equal(result.port, newPort);
    assert.equal((await readFile(paths.portFile, "utf8")).trim(), String(newPort));
  });

  it("refuses a version-mismatched daemon when its pid is missing", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.portFile, "41119\n", "utf8");

    await assert.rejects(
      ensureDaemon({
        stateRoot,
        probeDaemon: async (candidatePort) => {
          assert.equal(candidatePort, 41_119);
          return { ...daemonHello(), daemonVersion: "0.0.1" };
        },
        timeoutMs: 100,
        retryMs: 5,
      }),
      /cannot restart because .*daemon\.pid is missing/,
    );
  });

  it("refuses to overwrite discovery for a live daemon on another port", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidFile, `${process.pid}\n`, "utf8");
    await writeFile(paths.portFile, "41113\n", "utf8");

    await assert.rejects(
      writeDaemonDiscoveryFiles({
        stateRoot,
        pid: process.pid,
        port: 41_114,
        probeDaemon: async (candidatePort) => {
          assert.equal(candidatePort, 41_113);
          return daemonHello();
        },
      }),
      /already running on port 41113/,
    );

    assert.equal((await readFile(paths.portFile, "utf8")).trim(), "41113");
  });

  it("overwrites stale discovery when the old port cannot be probed", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidFile, "99999999\n", "utf8");
    await writeFile(paths.portFile, "41115\n", "utf8");

    await writeDaemonDiscoveryFiles({
      stateRoot,
      pid: process.pid,
      port: 41_116,
      probeDaemon: async () => {
        throw new Error("stale");
      },
    });

    assert.equal((await readFile(paths.portFile, "utf8")).trim(), "41116");
  });
});
