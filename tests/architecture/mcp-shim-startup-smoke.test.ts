import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// AGE-110 hotfix: ec97ac9 dropped the `resolveMcpShimProject` import from
// hosts/claude/claude-mcp-shim.js. The source still parsed and every unit test
// passed, but the built shim died at startup with a ReferenceError, so every
// Claude session lost its comm_* tools. This test starts each BUILT shim and
// fails on any reference error during startup.
//
// SAFETY (2026-10-02 incident): a built shim resolves `.agents-comm-bus-dev.json`
// upward from its OWN location, and the marker's `daemonBin` + `discoveryRoot`
// override env isolation. Running the in-repo artifact from a dev checkout
// therefore spawned a real daemon into the real dev discovery and superseded
// the live dev daemon. So each shim is COPIED into a temp dir (no marker above
// it) and run from there, and a guard asserts that the real discovery files
// are byte-identical before and after.

const repoRoot = path.resolve(import.meta.dirname, "../..");
const DEV_MARKER = ".agents-comm-bus-dev.json";

async function builtShims(): Promise<string[]> {
  const shims = [
    path.join(repoRoot, "mcp-server/dist/claude-mcp-shim.js"),
    path.join(repoRoot, "mcp-server/dist/codex-mcp-shim.js"),
  ];
  for (const agent of ["claude", "codex"]) {
    const dir = path.join(repoRoot, "plugins", agent);
    const comms = await readdir(dir, { withFileTypes: true });
    for (const comm of comms) {
      if (comm.isDirectory()) shims.push(path.join(dir, comm.name, `${agent}-mcp-shim.js`));
    }
  }
  return shims;
}

/** Real discovery dirs a leaked spawn could touch: the checkout's dev slot + the home slot. */
async function realDiscoveryDirs(): Promise<string[]> {
  const dirs = [path.join(os.homedir(), ".agents-comm-bus")];
  const markerPath = path.join(repoRoot, DEV_MARKER);
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse((await readFile(markerPath, "utf8")).replace(/^﻿/, ""));
      if (typeof marker.discoveryRoot === "string") dirs.push(path.resolve(repoRoot, marker.discoveryRoot));
    } catch {
      // unreadable marker: the home slot is still guarded
    }
  }
  return dirs;
}

async function snapshotDiscovery(dirs: string[]): Promise<string> {
  const parts: string[] = [];
  for (const dir of dirs) {
    for (const name of ["port", "daemon.pid", "owner.json"]) {
      const file = path.join(dir, name);
      parts.push(`${file}=${existsSync(file) ? await readFile(file, "utf8") : "<absent>"}`);
    }
  }
  return parts.join("\n");
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(AGENTS_COMM_BUS_|HERDR_|CODEX_|CLAUDE_)/.test(key)) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.AGENTS_COMM_BUS_ROOT = path.join(home, ".agents-comm-bus");
  env.AGENTS_COMM_BUS_STATE_ROOT = path.join(home, ".agents-comm-bus");
  env.AGENTS_COMM_BUS_DISCOVERY_ROOT = path.join(home, "discovery");
  env.AGENTS_COMM_BUS_BIN = path.join(home, "missing-daemon.js");
  env.CLAUDE_PROJECT_DIR = home;
  return env;
}

function runShim(shim: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim], { env, cwd, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    // Closing stdin ends the MCP transport; startup code runs before that.
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 8_000);
    child.on("exit", () => { clearTimeout(timer); resolve(stderr); });
  });
}

describe("AGE-110 hotfix: built MCP shims start without reference errors", () => {
  it("every built claude/codex shim survives startup without ReferenceError, without touching real discovery", async () => {
    const shims = await builtShims();
    assert.ok(shims.length >= 4, `expected built shims, got ${shims.length}`);
    const guarded = await realDiscoveryDirs();
    const before = await snapshotDiscovery(guarded);

    for (const shim of shims) {
      const home = await mkdtemp(path.join(os.tmpdir(), "acb-shim-smoke-"));
      try {
        // Run a COPY from the temp dir so no dev marker sits above the artifact.
        const runDir = path.join(home, "run");
        await (await import("node:fs/promises")).mkdir(runDir, { recursive: true });
        await writeFile(path.join(runDir, "package.json"), '{"type":"module"}\n');
        const copy = path.join(runDir, path.basename(shim));
        await copyFile(shim, copy);
        assert.equal(existsSync(path.join(runDir, DEV_MARKER)), false);

        const stderr = await runShim(copy, isolatedEnv(home), runDir);
        assert.doesNotMatch(
          stderr,
          /ReferenceError|TypeError: \S+ is not a function|is not defined/,
          `${path.relative(repoRoot, shim)} crashed at startup:\n${stderr.slice(0, 800)}`,
        );
      } finally {
        // Windows can hold the dir briefly after the child exits (EBUSY);
        // cleanup is best-effort and must not fail the startup assertion.
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
      }
    }

    assert.equal(
      await snapshotDiscovery(guarded),
      before,
      "a shim run changed REAL discovery files (port/daemon.pid/owner.json): isolation leak",
    );
  });
});
