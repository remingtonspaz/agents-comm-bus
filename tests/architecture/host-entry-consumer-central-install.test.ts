import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { INSTALL_STAMP_NAME } from "../../core-daemon/host-runtime/ensure-central-install.js";
import { resolveCentralPaths } from "../../core-daemon/host-runtime/node-fs-seam.js";

// AGE-61 — consumer-context central-install proof: an external package under
// node_modules (outside the repo source tree) imports entryEnsures from
// agents-comm-bus/host-entry and resolves bundles via pluginInstallDir/fromDir
// with NO hosts/ reachback.

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("../../agents-comm-bus", import.meta.url));

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

async function fixturePlugin(withStamp: boolean): Promise<{ pluginDir: string; hookDir: string }> {
  const pluginDir = await tempDir("acb-he-ci-plugin-");
  await writeFile(path.join(pluginDir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
  await writeFile(path.join(pluginDir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
  await writeFile(path.join(pluginDir, "001.sql"), "SELECT 1;", "utf8");
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
        daemon_sidecars: ["001.sql"],
      }),
      "utf8",
    );
  }
  const hookDir = path.join(pluginDir, "hooks");
  await mkdir(hookDir, { recursive: true });
  return { pluginDir, hookDir };
}

describe("AGE-61 host-entry consumer-context central install", () => {
  it("entryEnsures via package export installs from fixtured plugin dir with no hosts/ reachback", async () => {
    const consumer = await tempDir("acb-he-ci-consumer-");
    const nodeModules = path.join(consumer, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      packageDir,
      path.join(nodeModules, "agents-comm-bus"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const { hookDir, pluginDir } = await fixturePlugin(true);
    const stateRoot = await tempDir("acb-he-ci-state-");

    const harness = [
      "import { entryEnsures } from 'agents-comm-bus/host-entry';",
      "const fromDir = process.env.AGENTS_COMM_BUS_FROM_DIR;",
      "let daemonStateRoot;",
      "const result = await entryEnsures({",
      "  fromDir,",
      "  agent: 'claude',",
      "  comm: 'telegram',",
      "  env: process.env,",
      "  deps: {",
      "    ensureDaemon: async (opts) => {",
      "      daemonStateRoot = opts?.stateRoot;",
      "      return { port: 1, hello: { daemonName: 'stub' }, spawned: false };",
      "    },",
      "  },",
      "});",
      "process.stdout.write(JSON.stringify({",
      "  ok: true,",
      "  mode: result.centralInstall?.mode,",
      "  port: result.port,",
      "  daemonStateRoot,",
      "  stateRoot: result.stateRoot,",
      "}) + '\\n');",
    ].join("\n");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTS_COMM_BUS_ROOT: stateRoot,
      AGENTS_COMM_BUS_FROM_DIR: hookDir,
    };
    delete env.AGENTS_COMM_BUS_BIN;

    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", harness], {
      cwd: consumer,
      env,
    });
    const out = JSON.parse(stdout.trim()) as {
      ok: boolean;
      mode: string;
      port: number;
      daemonStateRoot: string;
      stateRoot: string;
    };
    assert.equal(out.ok, true);
    assert.equal(out.mode, "production");
    assert.equal(out.port, 1);
    assert.equal(out.daemonStateRoot, stateRoot);
    assert.equal(out.stateRoot, stateRoot);

    const paths = resolveCentralPaths(stateRoot, "telegram");
    assert.equal(await exists(paths.daemonBundle), true, "daemon bundle installed via package export");
    assert.equal(await exists(paths.adapterBundle), true, "adapter bundle installed via package export");
    assert.equal(await exists(paths.daemonVersionFile), true, "daemon version metadata written");
    assert.equal(await exists(path.join(path.dirname(paths.daemonBundle), "001.sql")), true, "schema sidecar copied");
    assert.equal(await exists(path.join(pluginDir, INSTALL_STAMP_NAME)), true, "install stamp readable from plugin dir");
  });
});
