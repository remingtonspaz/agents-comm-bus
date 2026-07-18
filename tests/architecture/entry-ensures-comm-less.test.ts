import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { entryEnsures } from "../../hosts/common/install/entry-ensures.js";
import { INSTALL_STAMP_NAME } from "../../hosts/common/install/ensure-central-install.js";
import { DEV_MARKER_NAME } from "../../hosts/common/install/dev-config-resolver.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
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

function spyEnsureCentralInstall() {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { mode: "production" as const };
  };
  return {
    fn,
    get called() {
      return calls;
    },
  };
}

/** A production plugin dir: real bundle payloads + a valid install-stamp. */
async function fixturedPlugin(): Promise<string> {
  const dir = await tempDir("acb-eecl-plugin-");
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

describe("entryEnsures — comm-less mode (Pi core)", () => {
  it("LOAD-BEARING: comm omitted WITHOUT the skip flag STILL central-installs (Claude/Codex contract)", async () => {
    const stateRoot = await tempDir("acb-eecl-noflag-");
    const daemon = spyEnsureDaemon();
    const centralInstall = spyEnsureCentralInstall();

    await entryEnsures({
      agent: "claude",
      // NO comm, NO skipCentralInstall — the shape the Claude/Codex host callers use.
      // Omitting comm alone must NOT skip: ensureCentralInstall still runs and
      // infers stamp.comm. Only the explicit skip flag suppresses it.
      stateRoot,
      env: {},
      deps: {
        ensureDaemon: daemon.fn,
        ensureCentralInstall: centralInstall.fn,
      },
    });

    assert.equal(
      centralInstall.called,
      1,
      "omitting comm alone must NOT skip central-install (protects Claude/Codex hosts)",
    );
    assert.equal(daemon.called, 1);
  });

  it("prod comm-less call skips central-install and still ensures the daemon", async () => {
    const stateRoot = await tempDir("acb-eecl-state-");
    const daemon = spyEnsureDaemon();
    const centralInstall = spyEnsureCentralInstall();

    const result = await entryEnsures({
      agent: "pi",
      skipCentralInstall: true,
      stateRoot,
      env: {},
      deps: {
        ensureDaemon: daemon.fn,
        ensureCentralInstall: centralInstall.fn,
      },
    });

    assert.equal(centralInstall.called, 0, "central-install must not run when skipCentralInstall is true");
    assert.equal(daemon.called, 1, "ensureDaemon must still run");
    assert.deepEqual(result.centralInstall, { mode: "production", skipped: true });
  });

  it("dev-marker comm-less call propagates marker-derived paths to ensureDaemon", async () => {
    const daemon = spyEnsureDaemon();
    const centralInstall = spyEnsureCentralInstall();
    const projectRoot = await tempDir("acb-eecl-dev-");
    const binRel = "agents-comm-bus/dist/core-daemon/serve.js";
    await mkdir(path.join(projectRoot, path.dirname(binRel)), { recursive: true });
    await writeFile(path.join(projectRoot, binRel), "// daemon\n", "utf8");
    await writeFile(
      path.join(projectRoot, DEV_MARKER_NAME),
      JSON.stringify({ daemonBin: binRel, stateRoot: ".acb-dev", discoveryRoot: ".acb-discovery" }),
      "utf8",
    );

    const result = await entryEnsures({
      agent: "pi",
      skipCentralInstall: true,
      projectRoot,
      env: {},
      deps: {
        ensureDaemon: daemon.fn,
        ensureCentralInstall: centralInstall.fn,
      },
    });

    assert.equal(centralInstall.called, 0, "central-install must not run when skipCentralInstall is true");
    assert.equal(daemon.called, 1);
    assert.equal(result.centralInstall.mode, "source");
    assert.equal(result.centralInstall.skipped, true);
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
    assert.equal(
      daemon.lastOpts?.discoveryRoot,
      path.join(projectRoot, ".acb-discovery"),
      "marker-resolved discoveryRoot reached the daemon ensure",
    );
    assert.equal(
      (daemon.lastOpts?.env as Record<string, string> | undefined)?.AGENTS_COMM_BUS_DISCOVERY_ROOT,
      path.join(projectRoot, ".acb-discovery"),
      "marker-resolved discoveryRoot reached the daemon spawn env",
    );
    assert.equal(
      result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT,
      path.join(projectRoot, ".acb-discovery"),
      "entryEnsures returns the discovery root for long-lived reconnect clients",
    );
  });

  it("comm present still central-installs (regression guard)", async () => {
    const stateRoot = await tempDir("acb-eecl-comm-");
    const plugin = await fixturedPlugin();
    const daemon = spyEnsureDaemon();
    const centralInstall = spyEnsureCentralInstall();

    const result = await entryEnsures({
      agent: "pi",
      comm: "telegram",
      stateRoot,
      pluginInstallDir: plugin,
      env: {},
      deps: {
        ensureDaemon: daemon.fn,
        ensureCentralInstall: centralInstall.fn,
      },
    });

    assert.equal(centralInstall.called, 1, "central-install must run when comm is set");
    assert.equal(daemon.called, 1);
    assert.equal(result.centralInstall.mode, "production");
  });
});

describe("Pi core daemon-client contract", () => {
  it("does not hardcode comm discovery or loop entryEnsures", async () => {
    const source = await readFile(
      path.join(process.cwd(), "plugins/pi/core/extensions/agents-comm/daemon-client.ts"),
      "utf8",
    );

    assert.doesNotMatch(source, /SUPPORTED_COMMS/);
    assert.doesNotMatch(source, /"telegram"/);
    assert.doesNotMatch(source, /for\s*\([^)]*\)\s*\{[^}]*entryEnsures/s);
  });
});
