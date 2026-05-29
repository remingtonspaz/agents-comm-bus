import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, utimes, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runCentralInstall } from "../../hosts/common/install/run-central-install.js";
import { acquireInstallLock } from "../../hosts/common/install/install-lock.js";
import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";

// ---------------------------------------------------------------------------
// T3 — install lock + real-concurrency orchestrator races.
// Real temp root, real lockfile, real atomic-rename fs, Promise.all. No fake
// concurrency shortcuts: this is the only way the serialization is proven.
// ---------------------------------------------------------------------------

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "central-install-conc-"));
}

async function fakePlugin(comm: string, version: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
  await writeFile(path.join(dir, "daemon.bundle.js"), `DAEMON_BUNDLE_v${version}`, "utf8");
  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), `${comm.toUpperCase()}_ADAPTER_v${version}`, "utf8");
  return dir;
}

function actor(pluginInstallDir: string, o: Record<string, string> = {}) {
  const v = o.version ?? "1.0.0";
  return {
    agent: (o.agent ?? "claude") as "claude" | "codex",
    comm: o.comm ?? "telegram",
    pluginVersion: o.pluginVersion ?? v,
    daemonBundleVersion: o.daemonBundleVersion ?? v,
    adapterBundleVersion: o.adapterBundleVersion ?? v,
    pluginInstallDir,
    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
  };
}

async function readJson(p: string): Promise<any> {
  return JSON.parse(await readFile(p, "utf8"));
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** No leftover .tmp files promoted/abandoned under the central root. */
async function noStrayTemp(stateRoot: string, comm: string) {
  const paths = resolveCentralPaths(stateRoot, comm);
  for (const p of Object.values(paths)) {
    assert.equal(await exists(`${p}.tmp`), false, `stray temp file: ${p}.tmp`);
  }
}

// --- lock unit tests --------------------------------------------------------

describe("acquireInstallLock", () => {
  it("blocks a second acquirer until the first releases", async () => {
    const root = await tempRoot();
    const lockPath = path.join(root, "install.lock");

    const first = await acquireInstallLock(lockPath, { timeoutMs: 2_000, retryMs: 10 });
    let secondAcquired = false;
    const secondP = acquireInstallLock(lockPath, { timeoutMs: 2_000, retryMs: 10 }).then((l) => {
      secondAcquired = true;
      return l;
    });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(secondAcquired, false, "second must wait while first holds");

    await first.release();
    const second = await secondP;
    assert.equal(secondAcquired, true);
    await second.release();
  });

  it("steals a stale lock past staleMs", async () => {
    const root = await tempRoot();
    const lockPath = path.join(root, "install.lock");

    const abandoned = await acquireInstallLock(lockPath, {});
    // Backdate the lockfile so it looks abandoned, without releasing it.
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);

    const reclaimed = await acquireInstallLock(lockPath, { staleMs: 30_000, timeoutMs: 1_000, retryMs: 10 });
    assert.equal(reclaimed.stoleStale, true);
    await reclaimed.release();
    // (abandoned.release would no-op now: token no longer matches.)
    await abandoned.release();
  });

  it("times out when the lock stays held and is not stale", async () => {
    const root = await tempRoot();
    const lockPath = path.join(root, "install.lock");

    const held = await acquireInstallLock(lockPath, {});
    await assert.rejects(
      () => acquireInstallLock(lockPath, { timeoutMs: 120, retryMs: 10, staleMs: 600_000 }),
      /timed out/,
    );
    await held.release();
  });
});

// --- orchestrator concurrency races ----------------------------------------

describe("runCentralInstall — concurrent cold installs, same version", () => {
  it("converges on valid bytes + JSON with all references merged", async () => {
    const root = await tempRoot();
    const pA = await fakePlugin("telegram", "1.0.0");
    const pB = await fakePlugin("telegram", "1.0.0");

    await Promise.all([
      runCentralInstall(root, actor(pA, { agent: "claude" })),
      runCentralInstall(root, actor(pB, { agent: "codex" })),
    ]);

    const paths = resolveCentralPaths(root, "telegram");
    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
    const dv = await readJson(paths.daemonVersionFile); // parses => valid JSON
    assert.equal(dv.content_version, "1.0.0");
    const agents = dv.installed_by.map((e: any) => e.agent).sort();
    assert.deepEqual(agents, ["claude", "codex"]);
    await noStrayTemp(root, "telegram");
  });
});

describe("runCentralInstall — concurrent cold installs, mixed daemon versions", () => {
  it("the highest bundle version wins regardless of completion order, bytes match metadata", async () => {
    const root = await tempRoot();
    const pV1 = await fakePlugin("telegram", "1.0.0");
    const pV2 = await fakePlugin("telegram", "2.0.0");

    await Promise.all([
      runCentralInstall(root, actor(pV1, { agent: "claude", version: "1.0.0" })),
      runCentralInstall(root, actor(pV2, { agent: "codex", version: "2.0.0" })),
    ]);

    const paths = resolveCentralPaths(root, "telegram");
    const dv = await readJson(paths.daemonVersionFile);
    assert.equal(dv.content_version, "2.0.0", "highest wins");

    // The decisive cross-check: on-disk bytes must equal the winning version —
    // metadata is never ahead of bytes.
    const bytes = await readFile(paths.daemonBundle, "utf8");
    assert.equal(bytes, "DAEMON_BUNDLE_v2.0.0");
    assert.ok(bytes.includes(dv.content_version), "bytes correspond to content_version");

    // Both installers recorded as references regardless of who won the content.
    assert.equal(dv.installed_by.length, 2);
    await noStrayTemp(root, "telegram");
  });
});

describe("runCentralInstall — concurrent installs for different comms", () => {
  it("writes both adapters and keeps both daemon references", async () => {
    const root = await tempRoot();
    const tg = await fakePlugin("telegram", "1.0.0");
    const mx = await fakePlugin("matrix", "1.0.0");

    await Promise.all([
      runCentralInstall(root, actor(tg, { agent: "claude", comm: "telegram" })),
      runCentralInstall(root, actor(mx, { agent: "claude", comm: "matrix" })),
    ]);

    const tgPaths = resolveCentralPaths(root, "telegram");
    const mxPaths = resolveCentralPaths(root, "matrix");
    assert.equal(await readFile(tgPaths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
    assert.equal(await readFile(mxPaths.adapterBundle, "utf8"), "MATRIX_ADAPTER_v1.0.0");

    const dv = await readJson(tgPaths.daemonVersionFile);
    const refs = dv.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
    await noStrayTemp(root, "telegram");
    await noStrayTemp(root, "matrix");
  });
});

describe("runCentralInstall — concurrent same-comm installs from different agents", () => {
  it("adapter + daemon metadata stay valid under same-path contention", async () => {
    const root = await tempRoot();
    const pClaude = await fakePlugin("telegram", "1.0.0");
    const pCodex = await fakePlugin("telegram", "1.0.0");

    await Promise.all([
      runCentralInstall(root, actor(pClaude, { agent: "claude", comm: "telegram" })),
      runCentralInstall(root, actor(pCodex, { agent: "codex", comm: "telegram" })),
    ]);

    const paths = resolveCentralPaths(root, "telegram");
    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
    const av = await readJson(paths.adapterVersionFile); // valid JSON
    assert.equal(av.content_id, "telegram");
    const dv = await readJson(paths.daemonVersionFile);
    assert.equal(dv.installed_by.length, 2, "both agents merged into daemon provenance");
    await noStrayTemp(root, "telegram");
  });
});
