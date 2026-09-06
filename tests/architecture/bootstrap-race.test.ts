import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import { ensureDaemon, daemonStderrLogPath, writeDaemonDiscoveryFiles } from "../../core-daemon/bootstrap/ensure-daemon.js";
import {
  defaultSpawnLockStaleTimeoutMs,
  isSpawnLockStale,
  isTokenContentStale,
  parseSpawnLockToken,
  removeSpawnLockIfTokenMatches,
  removeStaleSpawnLock,
  tryAcquireSpawnLock,
} from "../../core-daemon/bootstrap/spawn-lock.js";
import { DEFAULT_BOOTSTRAP_TIMEOUT_MS, DEFAULT_SPAWN_LOCK_STALE_GRACE_MS } from "../../core-daemon/config.js";
import { DAEMON_VERSION, IPC_PROTOCOL_VERSION } from "../../core-daemon/config.js";
import {
  resolveConversationPaths,
  resolveDiscoveryPaths,
  resolveStatePaths,
} from "../../core-daemon/paths.js";
import type { DaemonHello } from "../../core-daemon/ipc/protocol.js";

function daemonHello(): DaemonHello {
  return {
    type: "daemon.hello",
    protocolVersion: IPC_PROTOCOL_VERSION,
    daemonVersion: DAEMON_VERSION,
    daemonName: "agents-comm-bus",
    metadata: { test: true },
  };
}

const createdRoots: string[] = [];

async function tempStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agents-comm-bus-test-"));
  createdRoots.push(root);
  return root;
}

// Every spawn is a fake: no daemon teardown is needed or permitted. PID files
// in these fixtures deliberately name this runner or unrelated fake processes.
after(async () => {
  for (const root of createdRoots) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("agents-comm-bus-test-"));
    await rm(root, { recursive: true, force: true });
  }
  const remaining = new Set(await readdir(os.tmpdir()));
  assert.deepEqual(createdRoots.filter(root => remaining.has(path.basename(root))), [],
    "this run must leave zero owned temp roots; historical roots are not ours");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("bootstrap fixture containment", () => {
  it("every ensure call explicitly supplies an isolated env and a fake spawn", async () => {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const ast = ts.createSourceFile("bootstrap-race.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ensureDaemon") {
        calls += 1;
        const options = node.arguments[0];
        assert.ok(options && ts.isObjectLiteralExpression(options), "ensure options must be inspectable inline");
        assert.ok(!options.properties.some(ts.isSpreadAssignment), "spread options could override containment");
        const env = options.properties.find(p => p.name && ts.isIdentifier(p.name) && p.name.text === "env");
        assert.ok(env && ts.isPropertyAssignment(env) && ts.isObjectLiteralExpression(env.initializer),
          `line ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: explicit env object required`);
        assert.ok(!env.initializer.properties.some(ts.isSpreadAssignment), "env must not inherit ambient keys");
        const spawn = options.properties.find(p => p.name && ts.isIdentifier(p.name) && p.name.text === "spawnDaemon");
        assert.ok(spawn, "fake spawnDaemon is mandatory even on expected no-spawn paths");
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(calls >= 19, "guard must inspect the actual fixture calls");
  });

  it("ambient poisoned discovery/bin cannot escape an explicitly isolated fake-spawn case", async () => {
    const stateRoot = await tempStateRoot();
    const sentinel = path.join(stateRoot, "sentinel-discovery");
    const sentinelBin = path.join(stateRoot, "sentinel-bin", "daemon.js");
    await mkdir(sentinel);
    await mkdir(path.dirname(sentinelBin));
    await writeFile(sentinelBin, 'throw new Error("SENTINEL MUST NEVER EXECUTE");\n');
    const saved = { bin: process.env.AGENTS_COMM_BUS_BIN, discovery: process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT };
    process.env.AGENTS_COMM_BUS_BIN = sentinelBin;
    process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT = sentinel;
    let spawns = 0;
    try {
      await ensureDaemon({
        stateRoot,
        env: {},
        log: () => {},
        spawnDaemon: async (paths, discovery) => {
          spawns += 1;
          // Check BEFORE any discovery write, including under the env mutation.
          assert.equal(paths.root, stateRoot);
          assert.equal(discovery.root, stateRoot, "ambient discovery poison escaped isolation");
          await writeFile(discovery.portFile, "41140");
        },
        probeDaemon: async () => daemonHello(),
        timeoutMs: 1000,
        retryMs: 5,
      });
      assert.equal(spawns, 1, "the spawn path must actually be exercised");
      assert.deepEqual(await readdir(sentinel), []);
      assert.deepEqual(await readdir(path.dirname(sentinelBin)), ["daemon.js"]);
    } finally {
      if (saved.bin === undefined) delete process.env.AGENTS_COMM_BUS_BIN;
      else process.env.AGENTS_COMM_BUS_BIN = saved.bin;
      if (saved.discovery === undefined) delete process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT;
      else process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT = saved.discovery;
    }
  });
});

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

  it("defaults discovery paths to the durable state root", () => {
    const stateRoot = path.join(os.tmpdir(), "state-root");
    const discovery = resolveDiscoveryPaths({ stateRoot });

    assert.equal(discovery.root, stateRoot);
    assert.equal(discovery.pidFile, path.join(stateRoot, "daemon.pid"));
    assert.equal(discovery.portFile, path.join(stateRoot, "port"));
    assert.equal(discovery.spawnLock, path.join(stateRoot, ".spawn.lock"));
  });

  it("can split discovery files from durable state", () => {
    const stateRoot = path.join(os.tmpdir(), "state-root");
    const discoveryRoot = path.join(os.tmpdir(), "checkout", ".agents-comm-bus-discovery");
    const state = resolveStatePaths({ stateRoot });
    const discovery = resolveDiscoveryPaths({ stateRoot, discoveryRoot });

    assert.equal(state.database, path.join(stateRoot, "agents-comm-bus.db"));
    assert.equal(discovery.root, discoveryRoot);
    assert.equal(discovery.pidFile, path.join(discoveryRoot, "daemon.pid"));
    assert.equal(discovery.portFile, path.join(discoveryRoot, "port"));
    assert.equal(discovery.spawnLock, path.join(discoveryRoot, ".spawn.lock"));
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
  it("default bootstrap timeout allows realistic cold-start budget", () => {
    assert.ok(DEFAULT_BOOTSTRAP_TIMEOUT_MS >= 20_000);
  });

  it("timeout error includes daemon stderr log path and bounded tail", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    const oldPrefix = "UNIQUE-START-MARKER-ONLY-AT-FILE-START\n" + "filler-line\n".repeat(600);
    const recentLine = "RECENT-DAEMON-ERROR-LINE";
    await writeFile(daemonStderrLogPath(stateRoot), `${oldPrefix}${recentLine}\n`, "utf8");

    await assert.rejects(
      ensureDaemon({ env: {},
        stateRoot,
        probeDaemon: async () => {
          throw new Error("daemon not ready");
        },
        spawnDaemon: async () => {},
        timeoutMs: 50,
        retryMs: 5,
      }),
      (err: Error) => {
        assert.match(err.message, /Timed out starting agents-comm-bus daemon/);
        assert.match(err.message, new RegExp(escapeRegExp(daemonStderrLogPath(stateRoot))));
        assert.match(err.message, /RECENT-DAEMON-ERROR-LINE/);
        assert.doesNotMatch(err.message, /UNIQUE-START-MARKER-ONLY-AT-FILE-START/);
        return true;
      },
    );
  });

  it("timeout error survives missing stderr log", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });

    await assert.rejects(
      ensureDaemon({ env: {},
        stateRoot,
        probeDaemon: async () => {
          throw new Error("daemon not ready");
        },
        spawnDaemon: async () => {},
        timeoutMs: 50,
        retryMs: 5,
      }),
      (err: Error) => {
        assert.match(err.message, /Timed out starting agents-comm-bus daemon/);
        assert.match(err.message, new RegExp(escapeRegExp(daemonStderrLogPath(stateRoot))));
        assert.match(err.message, /log unavailable/);
        return true;
      },
    );
  });

  it("timeout error reports empty stderr log", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(daemonStderrLogPath(stateRoot), "", "utf8");

    await assert.rejects(
      ensureDaemon({ env: {},
        stateRoot,
        probeDaemon: async () => {
          throw new Error("daemon not ready");
        },
        spawnDaemon: async () => {},
        timeoutMs: 50,
        retryMs: 5,
      }),
      (err: Error) => {
        assert.match(err.message, /Timed out starting agents-comm-bus daemon/);
        assert.match(err.message, new RegExp(escapeRegExp(daemonStderrLogPath(stateRoot))));
        assert.match(err.message, /log empty/);
        assert.doesNotMatch(err.message, /--- recent stderr/);
        return true;
      },
    );
  });

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
      ensureDaemon({ env: {}, stateRoot, spawnDaemon, probeDaemon, timeoutMs: 1_000, retryMs: 5 }),
      ensureDaemon({ env: {}, stateRoot, spawnDaemon, probeDaemon, timeoutMs: 1_000, retryMs: 5 }),
    ]);

    assert.equal(spawnCount, 1);
    assert.equal(a.port, port);
    assert.equal(b.port, port);
    assert.equal(a.hello.protocolVersion, IPC_PROTOCOL_VERSION);
    assert.equal(b.hello.protocolVersion, IPC_PROTOCOL_VERSION);
  });

  it("converges concurrent callers when spawn writes discovery asynchronously", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    let spawnCount = 0;
    const port = 41_138;

    const spawnDaemon = async (): Promise<void> => {
      spawnCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 75));
      await writeDaemonDiscoveryFiles({ stateRoot, pid: process.pid, port });
    };

    const probeDaemon = async (candidatePort: number): Promise<DaemonHello> => {
      assert.equal(candidatePort, port);
      return daemonHello();
    };

    const [a, b, c] = await Promise.all([
      ensureDaemon({ env: {}, stateRoot, spawnDaemon, probeDaemon, timeoutMs: 2_000, retryMs: 5 }),
      ensureDaemon({ env: {}, stateRoot, spawnDaemon, probeDaemon, timeoutMs: 2_000, retryMs: 5 }),
      ensureDaemon({ env: {}, stateRoot, spawnDaemon, probeDaemon, timeoutMs: 2_000, retryMs: 5 }),
    ]);

    assert.equal(spawnCount, 1);
    assert.equal(a.port, port);
    assert.equal(b.port, port);
    assert.equal(c.port, port);
    await assert.rejects(readFile(paths.spawnLock, "utf8"), /ENOENT/);
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

    const result = await ensureDaemon({ env: {},
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

  it("does not reuse or terminate a compatible daemon in another discovery root", async () => {
    const stateRoot = await tempStateRoot();
    const prodDiscovery = path.join(stateRoot, "prod-discovery");
    const devDiscovery = path.join(stateRoot, "dev-discovery");
    const prodPaths = resolveDiscoveryPaths({ stateRoot, discoveryRoot: prodDiscovery });
    const devPaths = resolveDiscoveryPaths({ stateRoot, discoveryRoot: devDiscovery });
    await mkdir(prodPaths.root, { recursive: true });
    await writeFile(prodPaths.pidFile, "12345\n", "utf8");
    await writeFile(prodPaths.portFile, "41131\n", "utf8");

    let terminated = false;
    let spawned = false;
    const result = await ensureDaemon({ env: {},
      stateRoot,
      discoveryRoot: devDiscovery,
      isPidAlive: () => true,
      terminateDaemon: () => {
        terminated = true;
      },
      probeDaemon: async (candidatePort) => {
        assert.notEqual(candidatePort, 41_131, "dev slot must not probe prod port");
        assert.equal(candidatePort, 41_132);
        return daemonHello();
      },
      spawnDaemon: async (_statePaths, discoveryPaths) => {
        spawned = true;
        assert.equal(discoveryPaths.root, devDiscovery);
        await writeDaemonDiscoveryFiles({
          stateRoot,
          discoveryRoot: devDiscovery,
          pid: process.pid,
          port: 41_132,
        });
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.equal(terminated, false, "cross-root daemon must never be terminated");
    assert.equal(spawned, true, "empty dev discovery root should spawn dev daemon");
    assert.equal(result.port, 41_132);
    assert.equal((await readFile(prodPaths.portFile, "utf8")).trim(), "41131");
    assert.equal((await readFile(devPaths.portFile, "utf8")).trim(), "41132");
  });

  it("reuses a daemon with a different bundle version when the IPC protocol is compatible", async () => {
    // The whole point of the protocol-only reuse contract: a daemon at a
    // different DAEMON_VERSION (here, NEWER) but the SAME IPC protocol must be
    // talked to, never terminated. Keying reuse on daemon-version equality is
    // what made two shims at different patch versions respawn-fight forever.
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidFile, "12345\n", "utf8");
    await writeFile(paths.portFile, "41117\n", "utf8");

    let terminated = false;
    let spawned = false;

    const result = await ensureDaemon({ env: {},
      stateRoot,
      isPidAlive: () => true,
      terminateDaemon: () => {
        terminated = true;
      },
      probeDaemon: async (candidatePort) => {
        assert.equal(candidatePort, 41_117);
        return { ...daemonHello(), daemonVersion: "999.0.0" };
      },
      spawnDaemon: async () => {
        spawned = true;
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.equal(terminated, false, "a protocol-compatible daemon must not be terminated");
    assert.equal(spawned, false, "no respawn for a protocol-compatible daemon");
    assert.equal(result.spawned, false);
    assert.equal(result.port, 41_117);
  });

  it("terminates and replaces a daemon speaking an older incompatible IPC protocol", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidFile, "12345\n", "utf8");
    await writeFile(paths.portFile, "41117\n", "utf8");

    let oldPidAlive = true;
    let terminatedPid: number | undefined;
    let spawned = false;
    const newPort = 41_118;

    const result = await ensureDaemon({ env: {},
      stateRoot,
      isPidAlive: (pid) => pid === 12_345 && oldPidAlive,
      terminateDaemon: (pid) => {
        terminatedPid = pid;
        oldPidAlive = false;
      },
      probeDaemon: async (candidatePort) => {
        if (candidatePort === 41_117) {
          return { ...daemonHello(), protocolVersion: "0.9.0", metadata: { pid: 12_345, test: true } };
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

  it("terminates protocol mismatches only within the same discovery root", async () => {
    const stateRoot = await tempStateRoot();
    const prodDiscovery = path.join(stateRoot, "prod-discovery");
    const devDiscovery = path.join(stateRoot, "dev-discovery");
    const prodPaths = resolveDiscoveryPaths({ stateRoot, discoveryRoot: prodDiscovery });
    const devPaths = resolveDiscoveryPaths({ stateRoot, discoveryRoot: devDiscovery });
    await mkdir(prodPaths.root, { recursive: true });
    await writeFile(prodPaths.pidFile, "12345\n", "utf8");
    await writeFile(prodPaths.portFile, "41133\n", "utf8");

    let terminated = false;
    const result = await ensureDaemon({ env: {},
      stateRoot,
      discoveryRoot: devDiscovery,
      isPidAlive: () => true,
      terminateDaemon: () => {
        terminated = true;
      },
      probeDaemon: async (candidatePort) => {
        assert.equal(candidatePort, 41_134);
        return daemonHello();
      },
      spawnDaemon: async () => {
        await writeDaemonDiscoveryFiles({
          stateRoot,
          discoveryRoot: devDiscovery,
          pid: process.pid,
          port: 41_134,
        });
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.equal(terminated, false);
    assert.equal(result.port, 41_134);
    assert.equal((await readFile(prodPaths.portFile, "utf8")).trim(), "41133");
    assert.equal((await readFile(devPaths.portFile, "utf8")).trim(), "41134");
  });

  it("logs a loud warning when source mode shares the durable discovery root", async () => {
    const stateRoot = await tempStateRoot();
    const messages: string[] = [];

    await ensureDaemon({
      stateRoot,
      env: { AGENTS_COMM_BUS_BIN: path.join(stateRoot, "serve.js") },
      log: (message) => messages.push(message),
      probeDaemon: async (candidatePort) => {
        assert.equal(candidatePort, 41_135);
        return daemonHello();
      },
      spawnDaemon: async () => {
        await writeDaemonDiscoveryFiles({
          stateRoot,
          pid: process.pid,
          port: 41_135,
        });
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.match(messages.join("\n"), /source\/dev daemon is sharing the production discovery root/);
  });

  it("does not warn when source mode has its own discovery root", async () => {
    const stateRoot = await tempStateRoot();
    const discoveryRoot = path.join(stateRoot, ".agents-comm-bus-discovery");
    const messages: string[] = [];

    await ensureDaemon({
      stateRoot,
      discoveryRoot,
      env: { AGENTS_COMM_BUS_BIN: path.join(stateRoot, "serve.js") },
      log: (message) => messages.push(message),
      probeDaemon: async (candidatePort) => {
        assert.equal(candidatePort, 41_136);
        return daemonHello();
      },
      spawnDaemon: async () => {
        await writeDaemonDiscoveryFiles({
          stateRoot,
          discoveryRoot,
          pid: process.pid,
          port: 41_136,
        });
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.deepEqual(messages, []);
  });

  it("honors env-provided discovery root for direct ensureDaemon callers", async () => {
    const stateRoot = await tempStateRoot();
    const discoveryRoot = path.join(stateRoot, "direct-caller-discovery");
    const discoveryPaths = resolveDiscoveryPaths({ stateRoot, discoveryRoot });

    const result = await ensureDaemon({
      env: {
        AGENTS_COMM_BUS_STATE_ROOT: stateRoot,
        AGENTS_COMM_BUS_DISCOVERY_ROOT: discoveryRoot,
      },
      probeDaemon: async (candidatePort) => {
        assert.equal(candidatePort, 41_137);
        return daemonHello();
      },
      spawnDaemon: async (_statePaths, actualDiscoveryPaths) => {
        assert.equal(actualDiscoveryPaths.root, discoveryRoot);
        await writeDaemonDiscoveryFiles({
          stateRoot,
          discoveryRoot,
          pid: process.pid,
          port: 41_137,
        });
      },
      timeoutMs: 1_000,
      retryMs: 5,
    });

    assert.equal(result.port, 41_137);
    assert.equal((await readFile(discoveryPaths.portFile, "utf8")).trim(), "41137");
  });

  it("refuses to downgrade a daemon speaking a newer IPC protocol", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pidFile, "12345\n", "utf8");
    await writeFile(paths.portFile, "41121\n", "utf8");

    let terminated = false;
    await assert.rejects(
      ensureDaemon({ env: {}, spawnDaemon: () => assert.fail("unexpected daemon spawn"),
        stateRoot,
        isPidAlive: () => true,
        terminateDaemon: () => {
          terminated = true;
        },
        probeDaemon: async (candidatePort) => {
          assert.equal(candidatePort, 41_121);
          return { ...daemonHello(), protocolVersion: "2.0.0" };
        },
        timeoutMs: 100,
        retryMs: 5,
      }),
      /protocol 2\.0\.0 is newer than this client/,
    );
    assert.equal(terminated, false, "must not terminate (downgrade) a newer-protocol daemon");
  });

  it("skips terminating a protocol-incompatible daemon when identity is unknown", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.portFile, "41119\n", "utf8");

    let terminated = false;
    await assert.rejects(
      ensureDaemon({ env: {}, spawnDaemon: () => {
          throw new Error("unexpected daemon spawn");
        },
        stateRoot,
        terminateDaemon: () => {
          terminated = true;
        },
        probeDaemon: async (candidatePort) => {
          assert.equal(candidatePort, 41_119);
          return { ...daemonHello(), protocolVersion: "0.9.0" };
        },
        timeoutMs: 100,
        retryMs: 5,
      }),
      /unexpected daemon spawn|Timed out starting agents-comm-bus daemon/,
    );
    assert.equal(terminated, false);
    const auditDir = path.join(stateRoot, "audit");
    const files = await readdir(auditDir);
    const rows = (await Promise.all(files.map(file => readFile(path.join(auditDir, file), "utf8"))))
      .join("\n")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.kind === "daemon_terminate_skipped_identity_unknown").length, 1);
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

describe("spawn lock", () => {
  it("does not remove a live lock during non-owner retry cleanup", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    const liveToken = `${process.pid}:${Date.now()}`;
    await writeFile(paths.spawnLock, `${liveToken}\n`, "utf8");

    const removed = await removeStaleSpawnLock(paths.spawnLock, {
      isPidAlive: () => true,
      staleTimeoutMs: 5_000,
    });

    assert.equal(removed, false);
    assert.equal((await readFile(paths.spawnLock, "utf8")).trim(), liveToken);
  });

  it("reclaims a stale lock whose owner pid is dead", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.spawnLock, "99999999:1234567890\n", "utf8");

    const removed = await removeStaleSpawnLock(paths.spawnLock, {
      isPidAlive: () => false,
      staleTimeoutMs: 5_000,
    });

    assert.equal(removed, true);
    await assert.rejects(readFile(paths.spawnLock, "utf8"), /ENOENT/);
  });

  it("does not delete a lock replaced between stale inspection and removal", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    const staleToken = "99999999:1234567890";
    const newToken = `${process.pid}:${Date.now() + 60_000}`;
    await writeFile(paths.spawnLock, `${staleToken}\n`, "utf8");

    const removed = await removeStaleSpawnLock(paths.spawnLock, {
      isPidAlive: () => false,
      staleTimeoutMs: 5_000,
      testHookAfterStaleCheck: async () => {
        await writeFile(paths.spawnLock, `${newToken}\n`, "utf8");
      },
    });

    assert.equal(removed, false);
    assert.equal((await readFile(paths.spawnLock, "utf8")).trim(), newToken);
  });

  it("removeSpawnLockIfTokenMatches no-ops when the on-disk token changed", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    const staleToken = "99999999:1234567890";
    const newToken = `${process.pid}:${Date.now() + 60_000}`;
    await writeFile(paths.spawnLock, `${newToken}\n`, "utf8");

    const removed = await removeSpawnLockIfTokenMatches(paths.spawnLock, staleToken);

    assert.equal(removed, false);
    assert.equal((await readFile(paths.spawnLock, "utf8")).trim(), newToken);
  });

  it("uses bootstrap timeout plus grace for default stale classification", () => {
    assert.equal(defaultSpawnLockStaleTimeoutMs(5_000), 5_000 + DEFAULT_SPAWN_LOCK_STALE_GRACE_MS);
    assert.equal(
      isTokenContentStale(`${process.pid}:${Date.now() - 4_500}`, {
        isPidAlive: () => true,
        staleTimeoutMs: defaultSpawnLockStaleTimeoutMs(5_000),
      }),
      false,
    );
  });

  it("reclaims a stale lock whose age exceeds the configured timeout", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    const staleTimestamp = Date.now() - 10_000;
    await writeFile(paths.spawnLock, `${process.pid}:${staleTimestamp}\n`, "utf8");

    const removed = await removeStaleSpawnLock(paths.spawnLock, {
      isPidAlive: () => true,
      staleTimeoutMs: 1_000,
    });

    assert.equal(removed, true);
    await assert.rejects(readFile(paths.spawnLock, "utf8"), /ENOENT/);
  });

  it("treats malformed lock tokens as stale", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.spawnLock, "not-a-valid-token\n", "utf8");

    assert.deepEqual(parseSpawnLockToken("not-a-valid-token"), {});
    assert.equal(
      await isSpawnLockStale(paths.spawnLock, {
        isPidAlive: () => true,
        staleTimeoutMs: 5_000,
      }),
      true,
    );

    const lock = await tryAcquireSpawnLock(paths.spawnLock, {
      isPidAlive: () => true,
      staleTimeoutMs: 5_000,
    });
    assert.ok(lock);
    await lock!.release();
  });

  it("does not let a non-owner ensureDaemon retry delete a live spawn lock", async () => {
    const stateRoot = await tempStateRoot();
    const paths = resolveStatePaths({ stateRoot });
    await mkdir(paths.root, { recursive: true });
    const liveToken = `${process.pid}:${Date.now()}`;
    await writeFile(paths.spawnLock, `${liveToken}\n`, "utf8");

    await assert.rejects(
      ensureDaemon({ env: {},
        stateRoot,
        isPidAlive: () => true,
        probeDaemon: async () => daemonHello(),
        spawnDaemon: async () => {
          throw new Error("must not spawn while another caller holds a live lock");
        },
        timeoutMs: 100,
        retryMs: 5,
      }),
      /Timed out starting agents-comm-bus daemon/,
    );

    assert.equal((await readFile(paths.spawnLock, "utf8")).trim(), liveToken);
  });
});
