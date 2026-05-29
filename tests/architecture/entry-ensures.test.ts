import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { entryEnsures } from "../../hosts/common/install/entry-ensures.js";
import { INSTALL_STAMP_NAME } from "../../hosts/common/install/ensure-central-install.js";
import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
import { DEV_MARKER_NAME } from "../../hosts/common/install/dev-config-resolver.js";

// entryEnsures composes applyDevConfig -> ensureCentralInstall -> ensureDaemon.
// Tests use the REAL ensureCentralInstall (deterministic via fixtures/env) and
// a spy ensureDaemon, so they prove the real ordering/mode contract rather than
// only that a mock was called.

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A production plugin dir: real bundle payloads + a valid install-stamp. */
async function fixturedPlugin(): Promise<string> {
  const dir = await tempDir("acb-ee-plugin-");
  await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
  await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
  await writeFile(
    path.join(dir, INSTALL_STAMP_NAME),
    JSON.stringify({
      schema_version: 1,
      agent: "claude",
      comm: "telegram",
      plugin_version: "0.1.0",
      daemon_bundle_version: "1.0.0",
      adapter_bundle_version: "0.1.0",
    }),
    "utf8",
  );
  return dir;
}

function spyEnsureDaemon() {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { port: 51999, hello: { daemonName: "agents-comm-bus" }, spawned: false };
  };
  return { fn, get called() { return calls; } };
}

describe("entryEnsures — production mode", () => {
  it("runs central install then ensureDaemon, returning the daemon result + centralInstall", async () => {
    const stateRoot = await tempDir("acb-ee-state-");
    const plugin = await fixturedPlugin();
    const daemon = spyEnsureDaemon();

    const result = await entryEnsures({
      agent: "claude",
      comm: "telegram",
      stateRoot,
      pluginInstallDir: plugin,
      env: {}, // no AGENTS_COMM_BUS_BIN -> production
      deps: { ensureDaemon: daemon.fn },
    });

    assert.equal(daemon.called, 1, "ensureDaemon must be called");
    assert.equal(result.port, 51999, "returns the ensureDaemon result fields");
    assert.equal(result.spawned, false);
    assert.equal(result.centralInstall.mode, "production");
    // The install really happened (bundle landed) before the daemon was ensured.
    const paths = resolveCentralPaths(stateRoot, "telegram");
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
  });

  it("fails BEFORE ensureDaemon when production metadata is missing (no daemon spawn masks it)", async () => {
    const stateRoot = await tempDir("acb-ee-state-");
    const daemon = spyEnsureDaemon();

    await assert.rejects(
      () =>
        entryEnsures({
          agent: "claude",
          comm: "telegram",
          stateRoot,
          // no pluginInstallDir -> production strict failure
          env: {},
          deps: { ensureDaemon: daemon.fn },
        }),
      /missing or invalid plugin install metadata/,
    );
    assert.equal(daemon.called, 0, "ensureDaemon must NOT run after a central-install failure");
  });
});

describe("entryEnsures — source/dev mode", () => {
  it("skips central install but still ensures the daemon when AGENTS_COMM_BUS_BIN is set", async () => {
    const stateRoot = await tempDir("acb-ee-state-");
    const daemon = spyEnsureDaemon();

    const result = await entryEnsures({
      agent: "claude",
      comm: "telegram",
      stateRoot,
      env: { AGENTS_COMM_BUS_BIN: "/proj/core/serve.js" },
      deps: { ensureDaemon: daemon.fn },
    });

    assert.equal(result.centralInstall.mode, "source");
    assert.equal(result.centralInstall.skipped, true);
    assert.equal(daemon.called, 1, "daemon still ensured in source mode");
  });

  it("a gitignored dev marker resolves into source mode (marker -> env -> resolveInstallMode)", async () => {
    const stateRoot = await tempDir("acb-ee-state-");
    const daemon = spyEnsureDaemon();

    // A project root with a valid marker pointing at an existing source entry.
    const projectRoot = await tempDir("acb-ee-proj-");
    const binRel = "agents-comm-bus/dist/core-daemon/serve.js";
    await mkdir(path.join(projectRoot, path.dirname(binRel)), { recursive: true });
    await writeFile(path.join(projectRoot, binRel), "// daemon\n", "utf8");
    await writeFile(
      path.join(projectRoot, DEV_MARKER_NAME),
      JSON.stringify({ daemonBin: binRel }),
      "utf8",
    );

    const result = await entryEnsures({
      agent: "claude",
      comm: "telegram",
      stateRoot,
      projectRoot,
      env: {}, // marker supplies AGENTS_COMM_BUS_BIN
      deps: { ensureDaemon: daemon.fn },
    });

    assert.equal(result.centralInstall.mode, "source", "marker put us in source mode");
    assert.equal(daemon.called, 1);
  });
});
