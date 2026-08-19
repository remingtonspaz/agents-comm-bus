import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
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
const SLEEPER_SOURCE = "setInterval(() => {}, 86400000);\n";
const SPAWN_LOCK_NAME = ".spawn.lock";

const win32 = process.platform === "win32";
const win32Skip = win32 ? false : "Windows-only PowerShell test";

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeSentinels(
  discoveryRoot: string,
  pid = "11111\n",
  port = "22222\n",
  lock = "lock-bytes\n",
): Promise<void> {
  await mkdir(discoveryRoot, { recursive: true });
  await writeFile(path.join(discoveryRoot, "daemon.pid"), pid, "utf8");
  await writeFile(path.join(discoveryRoot, "port"), port, "utf8");
  await writeFile(path.join(discoveryRoot, SPAWN_LOCK_NAME), lock, "utf8");
}

async function readSentinelBytes(
  discoveryRoot: string,
): Promise<{ pid: string; port: string; lock: string }> {
  return {
    pid: await readFile(path.join(discoveryRoot, "daemon.pid"), "utf8"),
    port: await readFile(path.join(discoveryRoot, "port"), "utf8"),
    lock: await readFile(path.join(discoveryRoot, SPAWN_LOCK_NAME), "utf8"),
  };
}

async function setupHomedir(): Promise<{ homedir: string; productionDiscovery: string }> {
  const homedir = await tempRoot("acb-rdr-home-");
  const productionDiscovery = path.join(homedir, ".agents-comm-bus");
  await writeSentinels(productionDiscovery, "prod-pid\n", "prod-port\n", "prod-lock\n");
  return { homedir, productionDiscovery };
}

async function project(
  marker: Record<string, unknown> | null,
  opts: {
    daemonBin?: string;
    adaptersDir?: boolean;
    discoveryRoot?: string;
    stateRoot?: string;
    serveSource?: string;
  } = {},
): Promise<string> {
  const root = await tempRoot("acb-rdr-");
  const binRel = opts.daemonBin ?? "agents-comm-bus/dist/core-daemon/serve.js";
  await mkdir(path.join(root, path.dirname(binRel)), { recursive: true });
  await writeFile(path.join(root, binRel), opts.serveSource ?? "// fake daemon entry\n", "utf8");

  if (opts.adaptersDir) {
    await mkdir(path.join(root, "adapters"), { recursive: true });
  }
  if (opts.discoveryRoot) {
    await mkdir(path.join(root, opts.discoveryRoot), { recursive: true });
  }
  if (opts.stateRoot) {
    await mkdir(path.join(root, opts.stateRoot), { recursive: true });
  }

  if (marker !== null) {
    await writeFile(path.join(root, DEV_MARKER_NAME), JSON.stringify(marker), "utf8");
  }
  return root;
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

type RestartOpts = {
  respawn?: boolean;
  exec?: boolean;
  json?: boolean;
  discoveryRoot?: string;
  extraEnv?: NodeJS.ProcessEnv;
};

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const jsonStart = stdout.indexOf("{");
  assert.ok(jsonStart >= 0, `expected JSON output, got: ${stdout}`);
  return JSON.parse(stdout.slice(jsonStart).trim()) as Record<string, unknown>;
}

async function runRestartScript(
  repoRoot: string,
  opts: RestartOpts = {},
): Promise<Record<string, unknown>> {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    RESTART_SCRIPT,
    "-RepoDir",
    repoRoot,
  ];
  if (opts.discoveryRoot) {
    args.push("-DiscoveryRoot", opts.discoveryRoot);
  }
  if (opts.exec ?? true) args.push("-Exec");
  if (opts.json ?? true) args.push("-Json");
  if (opts.respawn) args.push("-Respawn");

  const { stdout } = await run(powershellPath(), args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      ...opts.extraEnv,
    },
  });
  return parseJsonOutput(stdout);
}

async function runRestartScriptRaw(
  repoRoot: string,
  opts: RestartOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    RESTART_SCRIPT,
    "-RepoDir",
    repoRoot,
  ];
  if (opts.discoveryRoot) {
    args.push("-DiscoveryRoot", opts.discoveryRoot);
  }
  if (opts.exec ?? true) args.push("-Exec");
  if (opts.json ?? true) args.push("-Json");
  if (opts.respawn) args.push("-Respawn");

  try {
    const { stdout, stderr } = await run(powershellPath(), args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        ...opts.extraEnv,
      },
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? error),
    };
  }
}

async function startSleeperDaemon(servePath: string): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [servePath], {
    stdio: "ignore",
    detached: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  assert.ok(typeof child.pid === "number");
  return {
    pid: child.pid,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    },
  };
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

    const { stdout } = await run(process.execPath, [HELPER, root], { cwd: REPO_ROOT });
    const result = JSON.parse(stdout.trim()) as { status: string; env: Record<string, string> };
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
      { stateRoot: ".agents-comm-bus-dev" },
    );

    const { stdout } = await run(process.execPath, [HELPER, root], { cwd: REPO_ROOT });
    const result = JSON.parse(stdout.trim()) as { status: string; env: Record<string, string> };
    assert.equal(result.status, "applied");
    assert.equal(result.env.AGENTS_COMM_BUS_ROOT, path.join(root, ".agents-comm-bus-dev"));
  });

  it("reports rejected status for an escaping daemonBin without exiting zero from import", async () => {
    const root = await project({ daemonBin: "../../evil/serve.js" });
    const { stdout } = await run(process.execPath, [HELPER, root], { cwd: REPO_ROOT });
    const result = JSON.parse(stdout.trim()) as { status: string; env: Record<string, string>; reasons: string[] };
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.env, {});
    assert.ok(result.reasons.some((r) => r.includes("escapes project root")));
  });
});

describe("restart-daemon.ps1 discovery-root resolution", () => {
  it(
    "reap-only clears dev discovery sentinels and leaves production sentinels untouched",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          discoveryRoot: ".agents-comm-bus-discovery",
        },
        { discoveryRoot: ".agents-comm-bus-discovery" },
      );
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);

      const result = await runRestartScript(root, { extraEnv: { USERPROFILE: homedir } });

      assert.equal(result.discoveryRoot, devDiscovery);
      assert.equal(result.spawnLockFile, path.join(devDiscovery, SPAWN_LOCK_NAME));
      assert.equal(result.clearedDiscovery, true);
      assert.equal(await fileExists(path.join(devDiscovery, "daemon.pid")), false);
      assert.equal(await fileExists(path.join(devDiscovery, "port")), false);
      assert.equal(await fileExists(path.join(devDiscovery, SPAWN_LOCK_NAME)), false);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
    },
  );

  it(
    "reap-only without a dev marker clears production discovery sentinels",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project(null);

      const result = await runRestartScript(root, { extraEnv: { USERPROFILE: homedir } });

      assert.equal(result.discoveryRoot, productionDiscovery);
      assert.equal(result.spawnLockFile, path.join(productionDiscovery, SPAWN_LOCK_NAME));
      assert.equal(result.clearedDiscovery, true);
      assert.equal(await fileExists(path.join(productionDiscovery, "daemon.pid")), false);
      assert.equal(await fileExists(path.join(productionDiscovery, "port")), false);
      assert.equal(await fileExists(path.join(productionDiscovery, SPAWN_LOCK_NAME)), false);
    },
  );

  it(
    "reap-only uses AGENTS_COMM_BUS_ROOT when only stateRoot is configured",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          stateRoot: ".agents-comm-bus-dev",
        },
        { stateRoot: ".agents-comm-bus-dev" },
      );
      const stateDiscovery = path.join(root, ".agents-comm-bus-dev");
      await writeSentinels(stateDiscovery, "state-pid\n", "state-port\n", "state-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);

      const result = await runRestartScript(root, { extraEnv: { USERPROFILE: homedir } });

      assert.equal(result.discoveryRoot, stateDiscovery);
      assert.equal(result.clearedDiscovery, true);
      assert.equal(await fileExists(path.join(stateDiscovery, SPAWN_LOCK_NAME)), false);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
    },
  );

  it(
    "dry-run reports the resolved discovery root and removes nothing",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          discoveryRoot: ".agents-comm-bus-discovery",
        },
        { discoveryRoot: ".agents-comm-bus-discovery" },
      );
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);
      const devBefore = await readSentinelBytes(devDiscovery);

      const result = await runRestartScript(root, {
        exec: false,
        extraEnv: { USERPROFILE: homedir },
      });

      assert.equal(result.dryRun, true);
      assert.equal(result.discoveryRoot, devDiscovery);
      assert.equal(result.clearedDiscovery, false);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
      assert.deepEqual(await readSentinelBytes(devDiscovery), devBefore);
    },
  );

  it(
    "explicit -DiscoveryRoot overrides dev marker resolution",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          discoveryRoot: ".agents-comm-bus-discovery",
        },
        { discoveryRoot: ".agents-comm-bus-discovery" },
      );
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      const explicitDiscovery = path.join(root, "explicit-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");
      await writeSentinels(explicitDiscovery, "explicit-pid\n", "explicit-port\n", "explicit-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);
      const devBefore = await readSentinelBytes(devDiscovery);

      const result = await runRestartScript(root, {
        discoveryRoot: explicitDiscovery,
        extraEnv: { USERPROFILE: homedir },
      });

      assert.equal(result.discoveryRoot, explicitDiscovery);
      assert.equal(result.spawnLockFile, path.join(explicitDiscovery, SPAWN_LOCK_NAME));
      assert.equal(result.clearedDiscovery, true);
      assert.equal(await fileExists(path.join(explicitDiscovery, SPAWN_LOCK_NAME)), false);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
      assert.deepEqual(await readSentinelBytes(devDiscovery), devBefore);
    },
  );

  it(
    "rejected dev marker fails closed without clearing any discovery sentinels",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project({ daemonBin: "../../evil/serve.js" });
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);
      const devBefore = await readSentinelBytes(devDiscovery);

      const { stderr } = await runRestartScriptRaw(root, { extraEnv: { USERPROFILE: homedir } });
      assert.match(stderr, /fail closed|rejected/i);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
      assert.deepEqual(await readSentinelBytes(devDiscovery), devBefore);
    },
  );

  it(
    "resolver command failure fails closed without clearing any discovery sentinels",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project({
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
      });
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);
      const devBefore = await readSentinelBytes(devDiscovery);

      const fakeBin = await tempRoot("acb-rdr-fakebin-");
      const realNode = process.execPath;
      const fakeNodeCmd = [
        "@echo off",
        "echo resolver boom 1>&2",
        "exit /b 9",
        `"${realNode.replace(/\\/g, "\\\\")}" %*`,
        "exit /b %ERRORLEVEL%",
      ].join("\r\n");
      await writeFile(path.join(fakeBin, "node.cmd"), fakeNodeCmd, "utf8");

      const { stderr } = await runRestartScriptRaw(root, {
        extraEnv: {
          USERPROFILE: homedir,
          PATH: `${fakeBin};${path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")}`,
        },
      });
      assert.match(stderr, /dev-config resolution failed/i);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
      assert.deepEqual(await readSentinelBytes(devDiscovery), devBefore);
    },
  );

  it(
    "explicit -DiscoveryRoot still fails closed for a rejected dev marker",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project({ daemonBin: "../../evil/serve.js" });
      const explicitDiscovery = path.join(root, "explicit-discovery");
      await writeSentinels(explicitDiscovery, "explicit-pid\n", "explicit-port\n", "explicit-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);
      const explicitBefore = await readSentinelBytes(explicitDiscovery);

      const { stderr } = await runRestartScriptRaw(root, {
        discoveryRoot: explicitDiscovery,
        extraEnv: { USERPROFILE: homedir },
      });
      assert.match(stderr, /fail closed|rejected/i);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
      assert.deepEqual(await readSentinelBytes(explicitDiscovery), explicitBefore);
    },
  );

  it(
    "reap-only kills a sleeper daemon whose command line matches the repo serve.js",
    { skip: win32Skip },
    async () => {
      const { homedir } = await setupHomedir();
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          discoveryRoot: ".agents-comm-bus-discovery",
        },
        { discoveryRoot: ".agents-comm-bus-discovery", serveSource: SLEEPER_SOURCE },
      );
      const servePath = path.join(root, "agents-comm-bus/dist/core-daemon/serve.js");
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");

      const sleeper = await startSleeperDaemon(servePath);
      try {
        const result = await runRestartScript(root, { extraEnv: { USERPROFILE: homedir } });
        assert.ok((result.killed as number[]).includes(sleeper.pid));
      } finally {
        await sleeper.stop();
      }
    },
  );

  it(
    "AGE-86 guard: reap-only must resolve dev discovery without -Respawn",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          discoveryRoot: ".agents-comm-bus-discovery",
        },
        { discoveryRoot: ".agents-comm-bus-discovery" },
      );
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);

      const result = await runRestartScript(root, { extraEnv: { USERPROFILE: homedir } });

      assert.notEqual(result.discoveryRoot, productionDiscovery);
      assert.equal(result.discoveryRoot, devDiscovery);
      assert.equal(await fileExists(path.join(devDiscovery, "daemon.pid")), false);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
    },
  );
});

describe("restart-daemon.ps1 -Respawn", () => {
  it(
    "fails before changes when the dev marker is absent and leaves discovery sentinels untouched",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project(null);
      const productionBefore = await readSentinelBytes(productionDiscovery);

      const { stderr } = await runRestartScriptRaw(root, {
        respawn: true,
        extraEnv: { USERPROFILE: homedir },
      });
      assert.match(stderr, /requires applied dev config/i);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
    },
  );

  it(
    "fails before changes for a rejected dev marker and leaves discovery sentinels untouched",
    { skip: win32Skip },
    async () => {
      const { homedir, productionDiscovery } = await setupHomedir();
      const root = await project({ daemonBin: "../../evil/serve.js" });
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");
      const productionBefore = await readSentinelBytes(productionDiscovery);
      const devBefore = await readSentinelBytes(devDiscovery);

      const { stderr } = await runRestartScriptRaw(root, {
        respawn: true,
        extraEnv: { USERPROFILE: homedir },
      });
      assert.match(stderr, /fail closed|rejected/i);
      assert.deepEqual(await readSentinelBytes(productionDiscovery), productionBefore);
      assert.deepEqual(await readSentinelBytes(devDiscovery), devBefore);
    },
  );

  it(
    "invokes the dev-config resolver exactly once per run",
    { skip: win32Skip },
    async () => {
      const { homedir } = await setupHomedir();
      const root = await project(
        {
          daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
          discoveryRoot: ".agents-comm-bus-discovery",
        },
        { discoveryRoot: ".agents-comm-bus-discovery" },
      );
      const devDiscovery = path.join(root, ".agents-comm-bus-discovery");
      await writeSentinels(devDiscovery, "dev-pid\n", "dev-port\n", "dev-lock\n");

      const fakeBin = await tempRoot("acb-rdr-countbin-");
      const countPath = path.join(fakeBin, "resolver-invocations.txt");
      const realNode = process.execPath;
      const helperNeedle = "resolve-dev-daemon-env.mjs".replace(/\\/g, "\\\\");

      const fakeNodeCmd = [
        "@echo off",
        "setlocal EnableDelayedExpansion",
        "set args=%*",
        `echo !args! | findstr /i "${helperNeedle}" >nul && (`,
        `  if exist "${countPath.replace(/\\/g, "\\\\")}" (`,
        `    set /p count=<"${countPath.replace(/\\/g, "\\\\")}"`,
        "  ) else (",
        "    set count=0",
        "  )",
        "  set /a count+=1",
        `  echo !count!>"${countPath.replace(/\\/g, "\\\\")}"`,
        ")",
        `"${realNode.replace(/\\/g, "\\\\")}" %*`,
        "exit /b %ERRORLEVEL%",
      ].join("\r\n");
      await writeFile(path.join(fakeBin, "node.cmd"), fakeNodeCmd, "utf8");

      await runRestartScript(root, {
        extraEnv: {
          USERPROFILE: homedir,
          PATH: `${fakeBin};${path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")}`,
        },
      });

      const count = Number((await readFile(countPath, "utf8")).trim());
      assert.equal(count, 1);
    },
  );

  it(
    "respawns through a fake node with resolver env applied",
    { skip: win32Skip },
    async () => {
      const { homedir } = await setupHomedir();
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
          USERPROFILE: homedir,
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
