import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { entryEnsures, resolveEntryContext } from "../../hosts/common/install/entry-ensures.js";
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
  let lastOpts: Record<string, unknown> | undefined;
  const fn = async (opts: Record<string, unknown>) => {
    calls += 1;
    lastOpts = opts;
    return { port: 51999, hello: { daemonName: "agents-comm-bus" }, spawned: false };
  };
  return {
    fn,
    get called() {
      return calls;
    },
    get lastOpts() {
      return lastOpts;
    },
  };
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

describe("entryEnsures — canonical stateRoot derivation", () => {
  it("uses AGENTS_COMM_BUS_ROOT when no explicit stateRoot, feeding it to both install and daemon", async () => {
    const envRoot = await tempDir("acb-ee-envroot-");
    const plugin = await fixturedPlugin();
    const daemon = spyEnsureDaemon();

    const result = await entryEnsures({
      agent: "claude",
      comm: "telegram",
      pluginInstallDir: plugin,
      // no explicit stateRoot — must derive from env
      env: { AGENTS_COMM_BUS_ROOT: envRoot },
      deps: { ensureDaemon: daemon.fn },
    });

    assert.equal(result.centralInstall.mode, "production");
    assert.equal(daemon.lastOpts?.stateRoot, envRoot, "daemon got the env-derived canonical root");
    assert.equal(
      daemon.lastOpts?.discoveryRoot,
      envRoot,
      "discovery root defaults to the canonical state root",
    );
    const paths = resolveCentralPaths(envRoot, "telegram");
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
  });

  it("falls back to the daemon default root (injected) when neither stateRoot nor env root is set", async () => {
    const defaultRoot = await tempDir("acb-ee-default-");
    const plugin = await fixturedPlugin();
    const daemon = spyEnsureDaemon();

    const result = await entryEnsures({
      agent: "claude",
      comm: "telegram",
      pluginInstallDir: plugin,
      env: {}, // no explicit stateRoot, no env root -> daemon default
      deps: {
        ensureDaemon: daemon.fn,
        resolveStatePaths: (() => ({ root: defaultRoot })) as never,
      },
    });

    assert.equal(result.centralInstall.mode, "production");
    assert.equal(daemon.lastOpts?.stateRoot, defaultRoot, "fell back to the injected default root");
    assert.equal(daemon.lastOpts?.discoveryRoot, defaultRoot, "default discovery root mirrors state root");
    const { access } = await import("node:fs/promises");
    await access(resolveCentralPaths(defaultRoot, "telegram").daemonBundle); // throws if not installed
  });

  it("propagates a dev-marker stateRoot to the daemon ensure (source mode)", async () => {
    const daemon = spyEnsureDaemon();
    const projectRoot = await tempDir("acb-ee-mk-");
    const binRel = "agents-comm-bus/dist/core-daemon/serve.js";
    await mkdir(path.join(projectRoot, path.dirname(binRel)), { recursive: true });
    await writeFile(path.join(projectRoot, binRel), "// daemon\n", "utf8");
    await writeFile(
      path.join(projectRoot, DEV_MARKER_NAME),
      JSON.stringify({ daemonBin: binRel, stateRoot: ".acb-dev" }),
      "utf8",
    );

    const result = await entryEnsures({
      agent: "claude",
      comm: "telegram",
      projectRoot,
      env: {}, // marker supplies AGENTS_COMM_BUS_BIN (source) + AGENTS_COMM_BUS_ROOT
      deps: { ensureDaemon: daemon.fn },
    });

    assert.equal(result.centralInstall.mode, "source");
    assert.equal(
      daemon.lastOpts?.stateRoot,
      path.join(projectRoot, ".acb-dev"),
      "marker-resolved stateRoot reached the daemon ensure",
    );
    assert.equal(
      (daemon.lastOpts?.env as Record<string, string> | undefined)?.AGENTS_COMM_BUS_BIN,
      path.join(projectRoot, binRel),
      "marker-resolved daemonBin reached the daemon spawn env",
    );
  });

  it("propagates a dev-marker discoveryRoot separately from durable stateRoot", async () => {
    const daemon = spyEnsureDaemon();
    const projectRoot = await tempDir("acb-ee-disc-");
    const binRel = "agents-comm-bus/dist/core-daemon/serve.js";
    await mkdir(path.join(projectRoot, path.dirname(binRel)), { recursive: true });
    await writeFile(path.join(projectRoot, binRel), "// daemon\n", "utf8");
    await writeFile(
      path.join(projectRoot, DEV_MARKER_NAME),
      JSON.stringify({
        daemonBin: binRel,
        discoveryRoot: ".agents-comm-bus-discovery",
      }),
      "utf8",
    );

    const result = await entryEnsures({
      agent: "claude",
      comm: "telegram",
      projectRoot,
      env: {},
      deps: {
        ensureDaemon: daemon.fn,
        resolveStatePaths: (() => ({ root: path.join(projectRoot, "durable-default") })) as never,
      },
    });

    assert.equal(daemon.lastOpts?.stateRoot, path.join(projectRoot, "durable-default"));
    assert.equal(
      daemon.lastOpts?.discoveryRoot,
      path.join(projectRoot, ".agents-comm-bus-discovery"),
      "marker-resolved discoveryRoot reached the daemon ensure",
    );
    assert.equal(
      (daemon.lastOpts?.env as Record<string, string> | undefined)?.AGENTS_COMM_BUS_DISCOVERY_ROOT,
      path.join(projectRoot, ".agents-comm-bus-discovery"),
      "marker-resolved discoveryRoot reached the daemon spawn env",
    );
    assert.equal(result.stateRoot, path.join(projectRoot, "durable-default"));
    assert.equal(result.discoveryRoot, path.join(projectRoot, ".agents-comm-bus-discovery"));
    assert.equal(
      result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT,
      path.join(projectRoot, ".agents-comm-bus-discovery"),
      "entryEnsures returns the exact env needed by long-lived reconnect clients",
    );
  });
});

describe("resolveEntryContext", () => {
  it("finds projectRoot at the nearest ancestor holding the dev marker", async () => {
    const root = await tempDir("acb-ee-ctx-");
    await writeFile(path.join(root, DEV_MARKER_NAME), "{}", "utf8");
    const hookDir = path.join(root, "hosts", "claude", "hooks");
    await mkdir(hookDir, { recursive: true });
    const ctx = resolveEntryContext(hookDir);
    assert.equal(ctx.projectRoot, root);
    assert.equal(ctx.pluginInstallDir, undefined, "no stamp in a dev tree");
  });

  it("finds pluginInstallDir at the nearest ancestor holding install-stamp.json", async () => {
    const pluginRoot = await tempDir("acb-ee-plug-");
    await writeFile(path.join(pluginRoot, INSTALL_STAMP_NAME), "{}", "utf8");
    const hookDir = path.join(pluginRoot, "hooks");
    await mkdir(hookDir, { recursive: true });
    const ctx = resolveEntryContext(hookDir);
    assert.equal(ctx.pluginInstallDir, pluginRoot);
    assert.equal(ctx.projectRoot, undefined, "no dev marker in a packaged install");
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
    assert.equal(
      (daemon.lastOpts?.env as Record<string, string> | undefined)?.AGENTS_COMM_BUS_BIN,
      "/proj/core/serve.js",
      "explicit source-mode daemonBin reached the daemon spawn env",
    );
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
    assert.equal(
      (daemon.lastOpts?.env as Record<string, string> | undefined)?.AGENTS_COMM_BUS_BIN,
      path.join(projectRoot, binRel),
      "marker-derived source-mode daemonBin reached ensureDaemon",
    );
    assert.equal(daemon.lastOpts?.discoveryRoot, stateRoot, "without marker discoveryRoot, default mirrors stateRoot");
  });
});
