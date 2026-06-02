import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ensureCentralInstall,
  resolveInstallMode,
  readInstallStamp,
  INSTALL_STAMP_NAME,
} from "../../hosts/common/install/ensure-central-install.js";
import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";

// ---------------------------------------------------------------------------
// Mode contract: AGENTS_COMM_BUS_BIN is the authoritative source-mode switch;
// production mode is strict and fails loud on missing install metadata.
// ---------------------------------------------------------------------------

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "central-install-mode-"));
}

/** A production plugin dir carrying real bundle payloads + an install stamp. */
async function fixturedPlugin(comm: string, version: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
  await writeFile(path.join(dir, "daemon.bundle.js"), `DAEMON_BUNDLE_v${version}`, "utf8");
  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), `${comm.toUpperCase()}_ADAPTER_v${version}`, "utf8");
  await writeFile(
    path.join(dir, INSTALL_STAMP_NAME),
    JSON.stringify({
      schema_version: 1,
      agent: "claude",
      comm,
      plugin_version: version,
      daemon_bundle_version: version,
      adapter_bundle_version: version,
    }),
    "utf8",
  );
  return dir;
}

describe("resolveInstallMode", () => {
  it("is source only when AGENTS_COMM_BUS_BIN is set, production otherwise", () => {
    assert.equal(resolveInstallMode({ AGENTS_COMM_BUS_BIN: "/proj/core/index.js" }), "source");
    assert.equal(resolveInstallMode({}), "production");
    assert.equal(resolveInstallMode({ AGENTS_COMM_BUS_ROOT: "/proj/.acb-dev" }), "production"); // ROOT alone is not the switch
  });
});

describe("readInstallStamp", () => {
  it("returns null when the stamp is absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nostamp-"));
    assert.equal(await readInstallStamp(dir), null);
  });

  it("returns null when required version fields are missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "badstamp-"));
    await writeFile(path.join(dir, INSTALL_STAMP_NAME), JSON.stringify({ agent: "claude", comm: "telegram" }), "utf8");
    assert.equal(await readInstallStamp(dir), null);
  });

  it("returns null when schema_version is not 1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "badschema-"));
    await writeFile(
      path.join(dir, INSTALL_STAMP_NAME),
      JSON.stringify({
        schema_version: 2,
        agent: "claude",
        comm: "telegram",
        plugin_version: "1.0.0",
        daemon_bundle_version: "1.0.0",
        adapter_bundle_version: "1.0.0",
      }),
      "utf8",
    );
    assert.equal(await readInstallStamp(dir), null);
  });

  it("parses a well-formed stamp", async () => {
    const dir = await fixturedPlugin("telegram", "1.0.0");
    const stamp = await readInstallStamp(dir);
    assert.ok(stamp);
    assert.equal(stamp.daemon_bundle_version, "1.0.0");
  });
});

describe("ensureCentralInstall — source mode", () => {
  it("skips central install and does NOT call runCentralInstall when AGENTS_COMM_BUS_BIN is set", async () => {
    const root = await tempRoot();
    let called = false;
    const spy = async () => {
      called = true;
      return { plan: {} as any, result: {} as any, stoleStale: false };
    };

    const res = await ensureCentralInstall({
      stateRoot: root,
      comm: "telegram",
      pluginInstallDir: "/irrelevant/in/source/mode",
      env: { AGENTS_COMM_BUS_BIN: "/proj/core/index.js" },
      deps: { runCentralInstall: spy },
    });

    assert.equal(res.mode, "source");
    assert.equal(res.skipped, true);
    assert.equal(called, false, "source mode must not run central install");
  });
});

describe("ensureCentralInstall — production mode, strict", () => {
  it("fails loud when pluginInstallDir is unset", async () => {
    const root = await tempRoot();
    await assert.rejects(
      () => ensureCentralInstall({ stateRoot: root, comm: "telegram", env: {} }),
      /missing or invalid plugin install metadata/,
    );
  });

  it("fails loud when the install stamp is absent (does not silently skip)", async () => {
    const root = await tempRoot();
    const emptyPlugin = await mkdtemp(path.join(os.tmpdir(), "empty-plugin-"));
    let called = false;
    const spy = async () => {
      called = true;
      return { plan: {} as any, result: {} as any, stoleStale: false };
    };

    await assert.rejects(
      () =>
        ensureCentralInstall({
          stateRoot: root,
          comm: "telegram",
          pluginInstallDir: emptyPlugin,
          env: {},
          deps: { runCentralInstall: spy },
        }),
      /missing or invalid plugin install metadata/,
    );
    assert.equal(called, false, "must not attempt install when metadata is missing");
  });

  it("fails loud when the stamp lacks agent/comm and the caller supplies none", async () => {
    const root = await tempRoot();
    // Valid versions + schema, but NO agent/comm in the stamp.
    const dir = await mkdtemp(path.join(os.tmpdir(), "noident-"));
    await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
    await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TG", "utf8");
    await writeFile(
      path.join(dir, INSTALL_STAMP_NAME),
      JSON.stringify({
        schema_version: 1,
        plugin_version: "1.0.0",
        daemon_bundle_version: "1.0.0",
        adapter_bundle_version: "1.0.0",
      }),
      "utf8",
    );
    let called = false;
    const spy = async () => {
      called = true;
      return { plan: {} as any, result: {} as any, stoleStale: false };
    };

    await assert.rejects(
      () => ensureCentralInstall({ stateRoot: root, pluginInstallDir: dir, env: {}, deps: { runCentralInstall: spy } }),
      /invalid actor identity/,
    );
    assert.equal(called, false, "must not run install with an unresolved actor");
  });

  it("accepts caller-supplied agent/comm overriding a stamp that omits them", async () => {
    const root = await tempRoot();
    const dir = await mkdtemp(path.join(os.tmpdir(), "ident-override-"));
    await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
    await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
    await writeFile(
      path.join(dir, INSTALL_STAMP_NAME),
      JSON.stringify({
        schema_version: 1,
        plugin_version: "1.0.0",
        daemon_bundle_version: "1.0.0",
        adapter_bundle_version: "1.0.0",
      }),
      "utf8",
    );

    const res = await ensureCentralInstall({
      stateRoot: root,
      agent: "claude",
      comm: "telegram",
      pluginInstallDir: dir,
      env: {},
      installedAt: "2026-05-29T00:00:00Z",
    });
    assert.equal(res.mode, "production");
    assert.equal(res.actor?.comm, "telegram");
    const paths = resolveCentralPaths(root, "telegram");
    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
  });

  it("builds the actor from the stamp and lands bundles via the real orchestrator", async () => {
    const root = await tempRoot();
    const plugin = await fixturedPlugin("telegram", "1.0.0");

    const res = await ensureCentralInstall({
      stateRoot: root,
      pluginInstallDir: plugin,
      env: {},
      installedAt: "2026-05-29T00:00:00Z",
    });

    assert.equal(res.mode, "production");
    assert.equal(res.actor?.daemonBundleVersion, "1.0.0");
    assert.equal(res.actor?.pluginVersion, "1.0.0");

    // The real runCentralInstall ran end-to-end: bundles + metadata on disk.
    const paths = resolveCentralPaths(root, "telegram");
    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
    const dv = JSON.parse(await readFile(paths.daemonVersionFile, "utf8"));
    assert.equal(dv.content_version, "1.0.0");
  });

  it("skips the lock-taking installer when stamped central content is already current", async () => {
    const root = await tempRoot();
    const plugin = await fixturedPlugin("telegram", "1.0.0");

    await ensureCentralInstall({
      stateRoot: root,
      pluginInstallDir: plugin,
      env: {},
      installedAt: "2026-05-29T00:00:00Z",
    });

    let called = false;
    const throwingInstaller = async () => {
      called = true;
      throw new Error("runCentralInstall should not run for current stamped content");
    };

    const res = await ensureCentralInstall({
      stateRoot: root,
      pluginInstallDir: plugin,
      env: {},
      installedAt: "2026-05-29T00:01:00Z",
      deps: { runCentralInstall: throwingInstaller },
    });

    assert.equal(res.mode, "production");
    assert.equal(res.skipped, true);
    assert.equal(res.actor?.daemonBundleVersion, "1.0.0");
    assert.equal(called, false, "current stamped content must not take install.lock");
  });

  it("lets a read-only MCP-style caller reuse runnable central content during a plugin update", async () => {
    const root = await tempRoot();
    const installed = await fixturedPlugin("telegram", "1.0.0");
    const incoming = await fixturedPlugin("telegram", "2.0.0");

    await ensureCentralInstall({
      stateRoot: root,
      pluginInstallDir: installed,
      env: {},
      installedAt: "2026-05-29T00:00:00Z",
    });

    let called = false;
    const throwingInstaller = async () => {
      called = true;
      throw new Error("read-only MCP startup should not take install.lock");
    };

    const res = await ensureCentralInstall({
      stateRoot: root,
      pluginInstallDir: incoming,
      env: {},
      installedAt: "2026-05-29T00:01:00Z",
      readOnlyIfCentralInstalled: true,
      deps: { runCentralInstall: throwingInstaller },
    });

    assert.equal(res.mode, "production");
    assert.equal(res.skipped, true);
    assert.equal(res.actor?.daemonBundleVersion, "2.0.0", "actor still reflects the incoming plugin stamp");
    assert.equal(called, false, "read-only caller must not take install.lock for runnable central content");

    const paths = resolveCentralPaths(root, "telegram");
    const dv = JSON.parse(await readFile(paths.daemonVersionFile, "utf8"));
    assert.equal(dv.content_version, "1.0.0", "read-only reuse does not upgrade central content");
  });
});

describe("ensureCentralInstall — stamp keeps provenance separate from content (regression guard)", () => {
  it("higher plugin_version shipping an older daemon bundle does not downgrade the installed daemon", async () => {
    const root = await tempRoot();

    // Seed: production install of daemon bundle 2.0.0.
    const v2 = await fixturedPlugin("telegram", "2.0.0");
    await ensureCentralInstall({
      stateRoot: root,
      pluginInstallDir: v2,
      env: {},
      installedAt: "2026-05-29T00:00:00Z",
    });

    // Incoming hotfix: HIGHER plugin_version (3.0.0) but an OLDER daemon bundle
    // (1.0.0). A provenance-keyed rule would wrongly treat it as "newer" and
    // downgrade the daemon. The stamp's three distinct fields prevent that.
    const hotfix = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
    await writeFile(path.join(hotfix, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
    await writeFile(path.join(hotfix, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
    await writeFile(
      path.join(hotfix, INSTALL_STAMP_NAME),
      JSON.stringify({
        schema_version: 1,
        agent: "claude",
        comm: "telegram",
        plugin_version: "3.0.0", // higher provenance
        daemon_bundle_version: "1.0.0", // older content
        adapter_bundle_version: "1.0.0",
      }),
      "utf8",
    );

    const res = await ensureCentralInstall({
      stateRoot: root,
      pluginInstallDir: hotfix,
      env: {},
      installedAt: "2026-05-29T01:00:00Z",
    });

    // The actor is built from three distinct fields, not a collapsed "version".
    assert.equal(res.actor?.pluginVersion, "3.0.0");
    assert.equal(res.actor?.daemonBundleVersion, "1.0.0");

    // Install keyed off the daemon BUNDLE version (1.0.0 < installed 2.0.0) →
    // no downgrade, regardless of the higher plugin_version.
    const paths = resolveCentralPaths(root, "telegram");
    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0", "daemon not downgraded");
    const dv = JSON.parse(await readFile(paths.daemonVersionFile, "utf8"));
    assert.equal(dv.content_version, "2.0.0");
  });
});
