import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// AGE-110 hotfix: ec97ac9 dropped the `resolveMcpShimProject` import from
// hosts/claude/claude-mcp-shim.js. The source still parsed and every unit test
// passed, but the built shim died at startup with a ReferenceError, so every
// Claude session lost its comm_* tools. This test starts each BUILT shim (the
// artifact Claude/Codex actually load) and fails on any reference/type error
// during startup. The daemon bin points at a missing file and HOME is a temp
// dir, so the shim can never reach or spawn a real daemon.

const repoRoot = path.resolve(import.meta.dirname, "../..");

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
  it("every built claude/codex shim survives startup without ReferenceError/TypeError", async () => {
    const shims = await builtShims();
    assert.ok(shims.length >= 4, `expected built shims, got ${shims.length}`);
    for (const shim of shims) {
      const home = await mkdtemp(path.join(os.tmpdir(), "acb-shim-smoke-"));
      try {
        const stderr = await runShim(shim, isolatedEnv(home), os.tmpdir());
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
  });
});
