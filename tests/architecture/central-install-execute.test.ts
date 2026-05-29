import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
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

describe("T2 executeInstallPlan — second comm install", () => {
  it("preserves the daemon + existing adapter and writes the new comm's adapter", async () => {
    const root = await tempRoot();
    const tgPlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TELEGRAM_ADAPTER");
    const mxPlugin = await fakePlugin("matrix", "DAEMON_BUNDLE_v1.0.0", "MATRIX_ADAPTER");

    await install(root, actor(tgPlugin, { comm: "telegram" }));
    const { paths: mxPaths } = await install(root, actor(mxPlugin, { comm: "matrix" }));

    // Telegram adapter untouched; matrix adapter freshly written.
    const tgPaths = resolveCentralPaths(root, "telegram");
    assert.equal(await readFile(tgPaths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER");
    assert.equal(await readFile(mxPaths.adapterBundle, "utf8"), "MATRIX_ADAPTER");

    // Shared daemon preserved (same version) and now referenced by both comms.
    assert.equal(await readFile(mxPaths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
    const dv = await readJson(mxPaths.daemonVersionFile);
    const refs = dv.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
  });
});

describe("T2 executeInstallPlan — missing-bundle recovery", () => {
  it("restores a lost daemon blob when the version file still claims it", async () => {
    const root = await tempRoot();
    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");

    await install(root, actor(plugin));

    // Simulate the blob going missing while metadata still records it.
    const paths = resolveCentralPaths(root, "telegram");
    await rm(paths.daemonBundle);
    assert.equal(await exists(paths.daemonBundle), false);

    // Rerunning the same install must detect daemonExists=false and rewrite
    // the blob (the !bundleExists recovery branch), leaving metadata valid.
    const { plan } = await install(root, actor(plugin));

    assert.equal(plan.daemon.writeBundle, true);
    assert.ok(plan.daemon.reasons.some((r: string) => r.includes("recovery")));
    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
    const dv = await readJson(paths.daemonVersionFile);
    assert.equal(dv.content_version, "1.0.0");
  });
});

describe("T2 executeInstallPlan — executor guard on a real root", () => {
  it("rejects a bundle-requiring plan with no source and creates no files", async () => {
    const root = await tempRoot();
    const noSrc = { ...actor("/does/not/matter"), pluginInstallDir: undefined as unknown as string };

    const state = await readCentralState(root, noSrc.comm);
    const plan = reconcileInstall(noSrc, state);
    const paths = resolveCentralPaths(root, noSrc.comm);

    await assert.rejects(
      () => executeInstallPlan(plan, noSrc, paths, createNodeFsSeam()),
      /pluginInstallDir is unset/,
    );

    // Nothing landed anywhere under the central root.
    assert.equal(await exists(paths.daemonBundle), false);
    assert.equal(await exists(paths.daemonVersionFile), false);
    assert.equal(await exists(paths.adapterBundle), false);
    assert.equal(await exists(paths.adapterVersionFile), false);
  });
});
