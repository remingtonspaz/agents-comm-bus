import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDaemon } from "../../core-daemon/bootstrap/ensure-daemon.js";
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

test("AGE-106: foreign-root hello is never reused, deleted, terminated, or replaced", async () => {
  for (const hasPid of [true, false]) {
    const root = await tempRoot();
    const foreign = path.join(root, "other-state");
    await writeFile(path.join(root, "port"), "41152");
    if (hasPid) await writeFile(path.join(root, "daemon.pid"), "12345");
    let probes = 0;
    await assert.rejects(ensureDaemon({ stateRoot: root, env: {}, timeoutMs: 70, retryMs: 5,
      isPidAlive: () => true, log: () => {},
      probeDaemon: async () => { probes += 1; return hello(foreign); },
      spawnDaemon: () => assert.fail("foreign daemon must not be replaced"),
      terminateDaemon: () => assert.fail("foreign daemon must not be terminated"),
    }), error => error instanceof Error && error.message.includes(foreign));
    assert.ok(probes > 1, "exercise the retry paths, not only the initial probe");
    assert.equal(await readFile(path.join(root, "port"), "utf8"), "41152");
    if (hasPid) assert.equal(await readFile(path.join(root, "daemon.pid"), "utf8"), "12345");
    const rows = (await audits(root)).filter(row => row.kind === "daemon_discovery_foreign_state_root");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail.reported_state_root, foreign);
  }
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
