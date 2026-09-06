import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDaemon } from "../../core-daemon/bootstrap/ensure-daemon.js";
import { claimDiscovery } from "../../core-daemon/bootstrap/discovery-claim.js";
import type { DaemonHello } from "../../core-daemon/ipc/protocol.js";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "age106-"));
  roots.push(root);
  return root;
}
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
function hello(stateRoot?: string): DaemonHello {
  return { type: "daemon.hello", daemonName: "agents-comm-bus", daemonVersion: "0.2.63",
    protocolVersion: "1.2.0", metadata: { pid: 12345, ...(stateRoot === undefined ? {} : { stateRoot }) } };
}
async function audits(root: string) {
  const files = await readdir(path.join(root, "audit"));
  const rows = await Promise.all(files.map(file => readFile(path.join(root, "audit", file), "utf8")));
  return rows.join("\n").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("AGE-106: explicit state root ignores ambient discovery", async () => {
  const root = await tempRoot();
  const foreign = path.join(root, "foreign");
  await mkdir(foreign);
  const logs: string[] = [];
  await ensureDaemon({ stateRoot: root, env: { AGENTS_COMM_BUS_DISCOVERY_ROOT: foreign },
    log: line => logs.push(line), timeoutMs: 500,
    spawnDaemon: async (_paths, discovery) => {
      assert.equal(discovery.root, root);
      await writeFile(discovery.portFile, "41150");
    },
    probeDaemon: async () => hello(root),
  });
  assert.deepEqual(await readdir(foreign), []);
  assert.equal(logs.filter(line => line.includes("ignoring AGENTS_COMM_BUS_DISCOVERY_ROOT")).length, 1);
});

test("AGE-106: all-env roots and explicit split roots retain their precedence", async () => {
  for (const explicit of [false, true]) {
    const root = await tempRoot();
    const discoveryRoot = path.join(root, "split");
    await ensureDaemon({ ...(explicit ? { stateRoot: root, discoveryRoot } : {}),
      env: { AGENTS_COMM_BUS_STATE_ROOT: root, AGENTS_COMM_BUS_DISCOVERY_ROOT: discoveryRoot },
      timeoutMs: 500,
      spawnDaemon: async (state, discovery) => {
        assert.equal(state.root, root);
        assert.equal(discovery.root, discoveryRoot);
        await writeFile(discovery.portFile, "41151");
      }, probeDaemon: async () => hello(root),
    });
    assert.equal(await readFile(path.join(discoveryRoot, "port"), "utf8"), "41151");
  }
});

test("AGE-106: foreign-root squatter may be replaced by a spawned daemon", async () => {
  const root = await tempRoot();
  const foreign = path.join(root, "other-state");
  const discoveryRoot = path.join(root, "discovery");
  await mkdir(discoveryRoot, { recursive: true });
  const squatter = {
    pid: 12345,
    port: 41152,
    stateRoot: foreign,
    startedAt: 1,
    protocolVersion: "1.2.0",
  };
  await writeFile(path.join(discoveryRoot, "owner.json"), `${JSON.stringify(squatter)}\n`);
  await writeFile(path.join(discoveryRoot, "daemon.pid"), `${squatter.pid}\n`);
  await writeFile(path.join(discoveryRoot, "port"), `${squatter.port}\n`);
  let spawns = 0;
  let replaced = false;
  const result = await ensureDaemon({
    stateRoot: root,
    discoveryRoot,
    env: {},
    timeoutMs: 500,
    retryMs: 5,
    isPidAlive: () => true,
    log: () => {},
    probeDaemon: async () => replaced ? hello(root) : hello(foreign),
    spawnDaemon: async (_paths, discovery) => {
      spawns += 1;
      await claimDiscovery({
        stateRoot: root,
        discoveryRoot: discovery.root,
        pid: 54321,
        port: 41153,
        startedAt: 2,
        isPidAlive: pid => pid === squatter.pid,
        probeDaemon: async () => hello(foreign),
      });
      replaced = true;
    },
  });
  assert.equal(spawns, 1);
  assert.equal(result.spawned, true);
  const owner = JSON.parse(await readFile(path.join(discoveryRoot, "owner.json"), "utf8"));
  assert.equal(owner.stateRoot, root);
});

test("AGE-106: matching normalized root is reused", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "port"), "41153");
  const result = await ensureDaemon({ stateRoot: root, env: {},
    spawnDaemon: () => assert.fail("must reuse"),
    probeDaemon: async () => hello(root.replaceAll("\\", "/") + "/"),
  });
  assert.equal(result.spawned, false);
});

test("AGE-106: legacy hello without state root remains compatible and audited", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "port"), "41154");
  const result = await ensureDaemon({ stateRoot: root, env: {},
    spawnDaemon: () => assert.fail("must reuse legacy"), probeDaemon: async () => hello(),
  });
  assert.equal(result.spawned, false);
  assert.equal((await audits(root)).filter(row => row.kind === "daemon_discovery_state_root_unknown").length, 1);
});
