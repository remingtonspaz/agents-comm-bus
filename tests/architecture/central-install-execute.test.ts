import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { reconcileInstall, executeInstallPlan } from "../../hosts/common/install/reconcile-central-install.js";
import { createNodeFsSeam, resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";

// ---------------------------------------------------------------------------
// T2 — executeInstallPlan against a REAL temp state root + real plugin payloads.
// Each scenario reads central state back from disk between installs, exactly as
// the install hook will: read fs -> build CentralState -> reconcile -> execute.
// ---------------------------------------------------------------------------

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "central-install-"));
}

/** Create a fake plugin install dir carrying version-stamped bundle payloads. */
async function fakePlugin(comm: string, daemonBytes: string, adapterBytes: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
  await writeFile(path.join(dir, "daemon.bundle.js"), daemonBytes, "utf8");
  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), adapterBytes, "utf8");
  return dir;
}

function actor(pluginInstallDir: string, o: Record<string, string> = {}) {
  return {
    agent: (o.agent ?? "claude") as "claude" | "codex",
    comm: o.comm ?? "telegram",
    pluginVersion: o.pluginVersion ?? "1.0.0",
    daemonBundleVersion: o.daemonBundleVersion ?? "1.0.0",
    adapterBundleVersion: o.adapterBundleVersion ?? "1.0.0",
    pluginInstallDir,
    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<any> {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** Read current central state from disk for a comm, as the hook would. */
async function readCentralState(stateRoot: string, comm: string) {
  const paths = resolveCentralPaths(stateRoot, comm);
  return {
    daemonExists: await exists(paths.daemonBundle),
    daemonVersionFile: await readJson(paths.daemonVersionFile),
    adapterExists: await exists(paths.adapterBundle),
    adapterVersionFile: await readJson(paths.adapterVersionFile),
    daemonRunning: false,
  };
}

/** Reconcile + execute a single install against the live temp root. */
async function install(stateRoot: string, a: ReturnType<typeof actor>) {
  const state = await readCentralState(stateRoot, a.comm);
  const plan = reconcileInstall(a, state);
  const paths = resolveCentralPaths(stateRoot, a.comm);
  const result = await executeInstallPlan(plan, a, paths, createNodeFsSeam());
  return { plan, paths, result };
}

describe("T2 executeInstallPlan — cold install on a real temp root", () => {
  it("lays down daemon + adapter bundles and version files with correct bytes", async () => {
    const root = await tempRoot();
    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TELEGRAM_ADAPTER_v1.0.0");

    const { paths } = await install(root, actor(plugin));

    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");

    const dv = await readJson(paths.daemonVersionFile);
    assert.equal(dv.content_version, "1.0.0");
    assert.equal(dv.content_kind, "daemon");
    assert.equal(dv.installed_by.length, 1);

    const av = await readJson(paths.adapterVersionFile);
    assert.equal(av.content_id, "telegram");
    assert.equal(av.content_version, "1.0.0");
  });
});

describe("T2 executeInstallPlan — upgrade replaces the daemon bytes", () => {
  it("a newer daemon bundle overwrites bin/daemon.js and bumps content_version", async () => {
    const root = await tempRoot();
    const v1 = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
    const v2 = await fakePlugin("telegram", "DAEMON_BUNDLE_v2.0.0", "TG_v2");

    await install(root, actor(v1, { daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }));
    const { paths } = await install(
      root,
      actor(v2, { agent: "codex", daemonBundleVersion: "2.0.0", adapterBundleVersion: "2.0.0" }),
    );

    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0");
    const dv = await readJson(paths.daemonVersionFile);
    assert.equal(dv.content_version, "2.0.0");
    assert.equal(dv.content_source.agent, "codex");
  });
});

describe("T2 executeInstallPlan — older install cannot downgrade on-disk bytes", () => {
  it("keeps the newer daemon bytes when an older bundle installs afterward", async () => {
    const root = await tempRoot();
    const v2 = await fakePlugin("telegram", "DAEMON_BUNDLE_v2.0.0", "TG_v2");
    const v1 = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");

    await install(root, actor(v2, { daemonBundleVersion: "2.0.0", adapterBundleVersion: "2.0.0" }));
    const { plan, paths } = await install(
      root,
      actor(v1, { agent: "codex", daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }),
    );

    assert.equal(plan.daemon.writeBundle, false);
    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0", "bytes not downgraded");
    const dv = await readJson(paths.daemonVersionFile);
    assert.equal(dv.content_version, "2.0.0");
    // ...but the older installer is still recorded as a reference.
    assert.equal(dv.installed_by.length, 2);
  });
});

describe("T2 executeInstallPlan — idempotent rerun touches nothing", () => {
  it("a repeat of the same install writes no bundle and no version file", async () => {
    const root = await tempRoot();
    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");

    await install(root, actor(plugin));
    const { plan, paths } = await install(root, actor(plugin, { installedAt: "2026-06-01T00:00:00Z" }));

    assert.equal(plan.daemon.writeBundle, false);
    assert.equal(plan.daemon.writeVersionFile, false);
    assert.equal(plan.adapter.writeBundle, false);
    assert.equal(plan.adapter.writeVersionFile, false);
    // On-disk content unchanged, including the original installed_at timestamp.
    const dv = await readJson(paths.daemonVersionFile);
    assert.equal(dv.installed_by[0].installed_at, "2026-05-18T20:25:00Z");
  });
});

describe("T2 executeInstallPlan — second agent merges provenance without recopying", () => {
  it("same bundle version from a second agent rewrites only the version file", async () => {
    const root = await tempRoot();
    const claudePlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
    const codexPlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");

    await install(root, actor(claudePlugin, { agent: "claude" }));
    const { plan, paths } = await install(root, actor(codexPlugin, { agent: "codex" }));

    assert.equal(plan.daemon.writeBundle, false, "identical bundle version -> no recopy");
    assert.equal(plan.daemon.writeVersionFile, true, "provenance changed -> rewrite metadata");

    const dv = await readJson(paths.daemonVersionFile);
    const agents = dv.installed_by.map((e: any) => e.agent).sort();
    assert.deepEqual(agents, ["claude", "codex"]);
  });
});
