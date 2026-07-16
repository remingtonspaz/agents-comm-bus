import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { DEV_MARKER_NAME } from "../../hosts/common/install/dev-config-resolver.js";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.join(fileURLToPath(import.meta.url), "../../.."));
const HELPER = path.join(REPO_ROOT, "scripts/resolve-dev-daemon-env.mjs");
const RESTART_SCRIPT = path.join(REPO_ROOT, "scripts/restart-daemon.ps1");

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function project(
  marker: Record<string, unknown> | null,
  opts: { daemonBin?: string; adaptersDir?: boolean; discoveryRoot?: string } = {},
): Promise<string> {
  const root = await tempRoot("acb-rdr-");
  const binRel = opts.daemonBin ?? "agents-comm-bus/dist/core-daemon/serve.js";
  await mkdir(path.join(root, path.dirname(binRel)), { recursive: true });
  await writeFile(path.join(root, binRel), "// fake daemon entry\n", "utf8");

  if (opts.adaptersDir) {
    await mkdir(path.join(root, "adapters"), { recursive: true });
  }
  if (opts.discoveryRoot) {
    await mkdir(path.join(root, opts.discoveryRoot), { recursive: true });
  }

  if (marker !== null) {
    await writeFile(path.join(root, DEV_MARKER_NAME), JSON.stringify(marker), "utf8");
  }
  return root;
}

async function runHelper(repoRoot: string): Promise<{ status: string; env: Record<string, string>; reasons: string[] }> {
  const { stdout } = await run(process.execPath, [HELPER, repoRoot], { cwd: REPO_ROOT });
  return JSON.parse(stdout.trim()) as { status: string; env: Record<string, string>; reasons: string[] };
}

async function runRestartScript(
  repoRoot: string,
  opts: { respawn?: boolean; extraEnv?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, unknown>> {
  const stateRoot = await tempRoot("acb-rdr-state-");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    RESTART_SCRIPT,
    "-RepoDir",
    repoRoot,
    "-StateRoot",
    stateRoot,
    "-Exec",
    "-Json",
  ];
  if (opts.respawn) args.push("-Respawn");

  const { stdout } = await run(powershell, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SystemRoot: systemRoot,
      ...opts.extraEnv,
    },
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("resolve-dev-daemon-env.mjs", () => {
  it("returns applied env with daemonBin, discoveryRoot, and adaptersDir", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
        adaptersDir: "adapters",
      },
      { adaptersDir: true, discoveryRoot: ".agents-comm-bus-discovery" },
    );

    const result = await runHelper(root);
    assert.equal(result.status, "applied");
    assert.equal(
      result.env.AGENTS_COMM_BUS_BIN,
      path.join(root, "agents-comm-bus/dist/core-daemon/serve.js"),
    );
    assert.equal(
      result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT,
      path.join(root, ".agents-comm-bus-discovery"),
    );
    assert.equal(result.env.AGENTS_COMM_BUS_ADAPTERS_DIR, path.join(root, "adapters"));
  });

  it("includes AGENTS_COMM_BUS_ROOT when stateRoot resolves inside the project", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        stateRoot: ".agents-comm-bus-dev",
      },
      { discoveryRoot: ".agents-comm-bus-dev" },
    );

    const result = await runHelper(root);
    assert.equal(result.status, "applied");
    assert.equal(result.env.AGENTS_COMM_BUS_ROOT, path.join(root, ".agents-comm-bus-dev"));
  });

  it("reports rejected status for an escaping daemonBin without exiting zero from import", async () => {
    const root = await project({ daemonBin: "../../evil/serve.js" });
    const result = await runHelper(root);
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.env, {});
    assert.ok(result.reasons.some((r) => r.includes("escapes project root")));
  });
});

describe("restart-daemon.ps1 -Respawn", () => {
  it(
    "fails loud when the dev marker is absent",
    { skip: process.platform !== "win32" ? "Windows-only PowerShell test" : false },
    async () => {
      const root = await project(null);
      await assert.rejects(
        () => runRestartScript(root, { respawn: true }),
        /requires applied dev config/,
      );
    },
  );

  it(
    "fails loud for a rejected dev marker and does not report a respawn pid",
    { skip: process.platform !== "win32" ? "Windows-only PowerShell test" : false },
    async () => {
      const root = await project({ daemonBin: "../../evil/serve.js" });
      await assert.rejects(
        () => runRestartScript(root, { respawn: true }),
        /requires applied dev config/,
      );
    },
  );

  it(
    "respawns through a fake node with resolver env applied",
    { skip: process.platform !== "win32" ? "Windows-only PowerShell test" : false },
    async () => {
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          discoveryRoot: ".agents-comm-bus-discovery",
          adaptersDir: "adapters",
        },
        { adaptersDir: true, discoveryRoot: ".agents-comm-bus-discovery" },
      );

      const fakeBin = await tempRoot("acb-rdr-fakebin-");
      const capturePath = path.join(fakeBin, "respawn-capture.env");
      const realNode = process.execPath;

      const fakeNodeCmd = [
        "@echo off",
        "setlocal EnableDelayedExpansion",
        `if "%~2"=="serve" (`,
        `  set > "${capturePath.replace(/\\/g, "\\\\")}"`,
        "  exit /b 0",
        ")",
        `"${realNode.replace(/\\/g, "\\\\")}" %*`,
        "exit /b %ERRORLEVEL%",
      ].join("\r\n");
      await writeFile(path.join(fakeBin, "node.cmd"), fakeNodeCmd, "utf8");

      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const result = await runRestartScript(root, {
        respawn: true,
        extraEnv: {
          PATH: `${fakeBin};${path.join(systemRoot, "System32")}`,
        },
      });

      assert.ok(typeof result.respawnedPid === "number" || typeof result.respawnedPid === "string");
      const respawnEnv = result.respawnEnv as Record<string, string>;
      assert.equal(
        respawnEnv.AGENTS_COMM_BUS_BIN,
        path.join(root, "agents-comm-bus/dist/core-daemon/serve.js"),
      );
      assert.equal(
        respawnEnv.AGENTS_COMM_BUS_DISCOVERY_ROOT,
        path.join(root, ".agents-comm-bus-discovery"),
      );
      assert.equal(respawnEnv.AGENTS_COMM_BUS_ADAPTERS_DIR, path.join(root, "adapters"));

      const captured = await readFile(capturePath, "utf8");
      assert.match(captured, new RegExp(`AGENTS_COMM_BUS_BIN=${respawnEnv.AGENTS_COMM_BUS_BIN.replace(/\\/g, "\\\\")}`));
      assert.match(
        captured,
        new RegExp(`AGENTS_COMM_BUS_DISCOVERY_ROOT=${respawnEnv.AGENTS_COMM_BUS_DISCOVERY_ROOT.replace(/\\/g, "\\\\")}`),
      );
      assert.match(
        captured,
        new RegExp(`AGENTS_COMM_BUS_ADAPTERS_DIR=${respawnEnv.AGENTS_COMM_BUS_ADAPTERS_DIR.replace(/\\/g, "\\\\")}`),
      );
    },
  );
});
