import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { INSTALL_STAMP_NAME } from "../../hosts/common/install/ensure-central-install.js";
import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";

// Real-installed-path subprocess proof for the entryEnsures wiring. Spawns the
// harness (which calls entryEnsures exactly as a wired hook does) against a
// fixtured plugin dir + a clean state root, and asserts the REAL central-install
// file effects — not that a mock was called. ensureDaemon is stubbed in the
// harness so no real daemon is spawned.

const run = promisify(execFile);
const HARNESS = fileURLToPath(new URL("./fixtures/entry-ensures-harness.mjs", import.meta.url));

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A production plugin dir (bundles + stamp) with a hooks/ subdir for fromDir. */
async function fixturePlugin(withStamp: boolean): Promise<{ pluginDir: string; hookDir: string }> {
  const pluginDir = await tempDir("acb-ee-sub-plugin-");
  await writeFile(path.join(pluginDir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
  await writeFile(path.join(pluginDir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
  if (withStamp) {
    await writeFile(
      path.join(pluginDir, INSTALL_STAMP_NAME),
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
  }
  const hookDir = path.join(pluginDir, "hooks");
  await mkdir(hookDir, { recursive: true });
  return { pluginDir, hookDir };
}

describe("entryEnsures wiring — subprocess real-installed-path proof", () => {
  it("production: a wired-hook-style invocation lands the real install, then ensures the daemon", async () => {
    const { hookDir } = await fixturePlugin(true);
    const stateRoot = await tempDir("acb-ee-sub-state-");

    const { stdout } = await run("node", [HARNESS, hookDir, stateRoot]);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.mode, "production");
    assert.equal(out.port, 1, "stubbed ensureDaemon ran and its result shape survived");

    // The decisive check: the real bundle was copied into the state root.
    const paths = resolveCentralPaths(stateRoot, "telegram");
    assert.equal(await exists(paths.daemonBundle), true, "daemon bundle really installed");
    assert.equal(await exists(paths.daemonVersionFile), true, "version metadata really written");
  });

  it("production failure: a missing stamp aborts BEFORE the daemon ensure, with nothing installed", async () => {
    const { hookDir } = await fixturePlugin(false); // no install-stamp.json
    const stateRoot = await tempDir("acb-ee-sub-state-");

    await assert.rejects(
      () => run("node", [HARNESS, hookDir, stateRoot]),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 3, "harness exits non-zero on entryEnsures throw");
        assert.match(e.stderr ?? "", /missing or invalid plugin install metadata/);
        return true;
      },
    );

    // Failed before any install: the state root has no daemon bundle.
    const paths = resolveCentralPaths(stateRoot, "telegram");
    assert.equal(await exists(paths.daemonBundle), false, "nothing installed on the failure path");
  });
});
