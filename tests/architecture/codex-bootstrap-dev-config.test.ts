import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { DEV_MARKER_NAME } from "../../hosts/common/install/dev-config-resolver.js";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.join(fileURLToPath(import.meta.url), "../../.."));
const BOOTSTRAP_SCRIPT = path.join(REPO_ROOT, "scripts/bootstrap-codex-session.ps1");
const HELPER_SCRIPT = path.join(REPO_ROOT, "scripts/resolve-dev-daemon-env.mjs");
const DEV_ENV_KEYS = [
  "AGENTS_COMM_BUS_BIN",
  "AGENTS_COMM_BUS_DISCOVERY_ROOT",
  "AGENTS_COMM_BUS_ADAPTERS_DIR",
  "AGENTS_COMM_BUS_ROOT",
] as const;

/** Must match EFFECTIVE_SNAPSHOT_SCHEMA in scripts/resolve-dev-daemon-env.mjs. */
const SNAPSHOT_SCHEMA = "agents-comm-bus/dev-daemon-env-effective@1";

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psSingleQuoted(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function project(
  marker: Record<string, unknown> | null,
  opts: {
    daemonBin?: string;
    adaptersDir?: boolean;
    discoveryRoot?: string;
    stateRoot?: string;
    includeHelper?: boolean;
  } = {},
): Promise<string> {
  const root = await tempRoot("acb-cbdc-");
  const binRel = opts.daemonBin ?? "agents-comm-bus/dist/core-daemon/serve.js";
  await mkdir(path.join(root, path.dirname(binRel)), { recursive: true });
  await writeFile(path.join(root, binRel), "// fake daemon entry\n", "utf8");

  const hostRuntimeDir = path.join(root, "agents-comm-bus/dist/core-daemon/host-runtime");
  await mkdir(hostRuntimeDir, { recursive: true });
  await copyFile(
    path.join(REPO_ROOT, "agents-comm-bus/dist/core-daemon/host-runtime/dev-config-resolver.js"),
    path.join(hostRuntimeDir, "dev-config-resolver.js"),
  );
  await copyFile(
    path.join(REPO_ROOT, "agents-comm-bus/dist/core-daemon/host-runtime/strip-bom.js"),
    path.join(hostRuntimeDir, "strip-bom.js"),
  );

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

  if (opts.includeHelper !== false) {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await copyFile(HELPER_SCRIPT, path.join(root, "scripts/resolve-dev-daemon-env.mjs"));
  }

  return root;
}

async function runEffectiveHelper(
  projectRoot: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{
  status: string;
  reasons: string[];
  env: Record<string, { present: boolean; value?: string }>;
}> {
  const { stdout } = await run(process.execPath, [HELPER_SCRIPT, projectRoot, "--effective"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
  });
  return JSON.parse(stdout.trim()) as {
    status: string;
    reasons: string[];
    env: Record<string, { present: boolean; value?: string }>;
  };
}

async function loadBootstrapFunctions(): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$bootstrapPath = ${psSingleQuoted(BOOTSTRAP_SCRIPT)}`,
    "$content = Get-Content -LiteralPath $bootstrapPath -Raw",
    "$marker = '$resolvedProject = (Resolve-Path -LiteralPath $ProjectDir).Path'",
    "$functionsOnly = $content.Substring(0, $content.IndexOf($marker))",
    "Invoke-Expression $functionsOnly",
  ].join("; ");
  return script;
}

async function generateAppServerWrapper(
  projectRoot: string,
  snapshotJson: string,
): Promise<string> {
  const pidFile = path.join(os.tmpdir(), "codex-devcfg-test.pid");
  const script = [
    await loadBootstrapFunctions(),
    `$snapshot = '${snapshotJson.replace(/'/g, "''")}' | ConvertFrom-Json`,
    `$wrapperPath = New-AppServerWrapper -Project ${psSingleQuoted(projectRoot)} -Url 'ws://127.0.0.1:4501' -Session 'codex_test_session' -Command 'codex' -PidFile ${psSingleQuoted(pidFile)} -Thread '' -Labels '' -DevDaemonEnvSnapshot $snapshot`,
    "Get-Content -LiteralPath $wrapperPath -Raw",
  ].join("; ");
  const { stdout } = await run(
    powershellPath(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: REPO_ROOT, env: process.env },
  );
  return stdout;
}

async function invokeApplyDevDaemonEnvSnapshot(
  snapshotJson: string,
  preset?: Record<string, string>,
): Promise<Record<string, string | undefined>> {
  const presetLines = preset
    ? Object.entries(preset)
        .map(([key, value]) => `$env:${key} = ${psSingleQuoted(value)}`)
        .join("; ")
    : "";
  const script = [
    await loadBootstrapFunctions(),
    presetLines,
    `$snapshot = '${snapshotJson.replace(/'/g, "''")}' | ConvertFrom-Json`,
    "Apply-DevDaemonEnvSnapshot -Snapshot $snapshot",
    "@{ AGENTS_COMM_BUS_BIN = $env:AGENTS_COMM_BUS_BIN; AGENTS_COMM_BUS_DISCOVERY_ROOT = $env:AGENTS_COMM_BUS_DISCOVERY_ROOT; AGENTS_COMM_BUS_ADAPTERS_DIR = $env:AGENTS_COMM_BUS_ADAPTERS_DIR; AGENTS_COMM_BUS_ROOT = $env:AGENTS_COMM_BUS_ROOT } | ConvertTo-Json -Compress",
  ]
    .filter(Boolean)
    .join("; ");
  const { stdout } = await run(
    powershellPath(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: REPO_ROOT, env: process.env },
  );
  return JSON.parse(stdout.trim()) as Record<string, string | undefined>;
}

async function runPlanOnlyRestart(projectRoot: string): Promise<{ relayPath?: string }> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$plan = & ${psSingleQuoted(BOOTSTRAP_SCRIPT)} -ProjectDir ${psSingleQuoted(projectRoot)} -RestartCurrent -SameTerminal -PlanOnly -Exec -Json -KillPid $PID | ConvertFrom-Json`,
    "$plan | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await run(
    powershellPath(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: projectRoot, env: process.env },
  );
  return JSON.parse(stdout.trim()) as { relayPath?: string };
}

async function readRelayScript(relayPath: string): Promise<string> {
  const relay = await readFile(relayPath, "utf8");
  const ps1Match = relay.match(/-File "([^"]+\.ps1)"/i);
  if (ps1Match) {
    return await readFile(ps1Match[1], "utf8");
  }
  return relay;
}

async function runResolveFromBootstrapScript(
  bootstrapScriptPath: string,
  projectRoot: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$bootstrapPath = ${psSingleQuoted(bootstrapScriptPath)}`,
    "$content = Get-Content -LiteralPath $bootstrapPath -Raw",
    "$marker = '$resolvedProject = (Resolve-Path -LiteralPath $ProjectDir).Path'",
    "$functionsOnly = $content.Substring(0, $content.IndexOf($marker))",
    "Invoke-Expression $functionsOnly",
    `$resolvedProject = ${psSingleQuoted(projectRoot)}`,
    "$snapshot = Resolve-DevDaemonEnvSnapshot -ProjectRoot $resolvedProject",
    "$snapshot.env.AGENTS_COMM_BUS_DISCOVERY_ROOT.value",
  ].join("; ");
  const { stdout } = await run(
    powershellPath(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd, env: { ...process.env, ...extraEnv } },
  );
  return stdout.trim();
}

describe("resolve-dev-daemon-env.mjs --effective", () => {
  it("emits explicit presence for all four keys", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
        adaptersDir: "adapters",
        stateRoot: ".agents-comm-bus-dev",
      },
      {
        adaptersDir: true,
        discoveryRoot: ".agents-comm-bus-discovery",
        stateRoot: ".agents-comm-bus-dev",
      },
    );

    const result = await runEffectiveHelper(root);
    assert.equal(result.status, "applied");
    for (const key of DEV_ENV_KEYS) {
      assert.ok(key in result.env, `missing key ${key}`);
      assert.equal(typeof result.env[key].present, "boolean");
    }
    assert.equal(result.env.AGENTS_COMM_BUS_ROOT.present, true);
    assert.equal(result.env.AGENTS_COMM_BUS_ROOT.value, path.join(root, ".agents-comm-bus-dev"));
  });

  it("marker present overrides inherited discovery root", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
      },
      { discoveryRoot: ".agents-comm-bus-discovery" },
    );
    const inherited = path.join(root, "inherited-discovery");
    const result = await runEffectiveHelper(root, {
      AGENTS_COMM_BUS_DISCOVERY_ROOT: inherited,
    });
    assert.equal(result.status, "applied");
    assert.equal(
      result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT.present,
      true,
    );
    assert.equal(
      result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT.value,
      path.join(root, ".agents-comm-bus-discovery"),
    );
    assert.notEqual(result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT.value, inherited);
  });

  it("marker absent preserves inherited discovery root in the effective snapshot", async () => {
    const root = await project(null);
    const inherited = path.join(root, "inherited-discovery");
    const result = await runEffectiveHelper(root, {
      AGENTS_COMM_BUS_DISCOVERY_ROOT: inherited,
    });
    assert.equal(result.status, "none");
    assert.equal(result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT.present, true);
    assert.equal(result.env.AGENTS_COMM_BUS_DISCOVERY_ROOT.value, inherited);
  });

  it("rejected marker exits non-zero in --effective mode", async () => {
    const root = await project({ daemonBin: "../../evil/serve.js" });
    await assert.rejects(
      () => runEffectiveHelper(root),
      (error: unknown) => {
        const err = error as { code?: number };
        assert.equal(err.code, 1);
        return true;
      },
    );
  });
});

describe("Codex bootstrap dev-config snapshot propagation", () => {
  it("generated app-server wrapper carries marker discovery root", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
      },
      { discoveryRoot: ".agents-comm-bus-discovery" },
    );
    const snapshot = await runEffectiveHelper(root);
    const wrapper = await generateAppServerWrapper(root, JSON.stringify(snapshot));
    const discovery = path.join(root, ".agents-comm-bus-discovery");
    assert.match(
      wrapper,
      new RegExp(`\\$env:AGENTS_COMM_BUS_DISCOVERY_ROOT = '${escapeRegex(discovery)}'`),
    );
  });

  it("repair restart relay carries dev-config snapshot assignments", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
      },
      { discoveryRoot: ".agents-comm-bus-discovery" },
    );
    const plan = await runPlanOnlyRestart(root);
    assert.ok(plan.relayPath, "expected relayPath in PlanOnly JSON output");
    const relay = await readRelayScript(plan.relayPath!);
    const discovery = path.join(root, ".agents-comm-bus-discovery");
    assert.match(
      relay,
      new RegExp(`\\$env:AGENTS_COMM_BUS_DISCOVERY_ROOT = '${escapeRegex(discovery)}'`),
    );
    // Assert the snapshot's CONTENT, not merely that the parameter is emitted:
    // `… = '` also matches an empty snapshot, so a regression that forwards
    // `''` would leave the downstream bootstrapper to re-resolve on its own —
    // exactly the per-entrypoint inference this issue removes — and still pass.
    const snapshotLine = relay
      .split("\n")
      .find((line) => line.includes("$paramsForBootstrapper.DevDaemonEnvSnapshotJson"));
    assert.ok(snapshotLine, "relay must carry the dev-config snapshot parameter");
    // The snapshot is embedded as JSON, so Windows separators appear escaped.
    const discoveryInJson = JSON.stringify(discovery).slice(1, -1);
    assert.match(
      snapshotLine!,
      new RegExp(escapeRegex(discoveryInJson)),
      "the relay's snapshot must carry the resolved discovery root, not an empty value",
    );
    assert.match(relay, /\$paramsForBootstrapper\.Exec = \$true/);
  });

  it("Apply-DevDaemonEnvSnapshot wires Exec-path env for marker discovery root", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
      },
      { discoveryRoot: ".agents-comm-bus-discovery" },
    );
    const snapshot = await runEffectiveHelper(root);
    const env = await invokeApplyDevDaemonEnvSnapshot(JSON.stringify(snapshot));
    assert.equal(
      env.AGENTS_COMM_BUS_DISCOVERY_ROOT,
      path.join(root, ".agents-comm-bus-discovery"),
    );
  });

  it("marker absent preserves inherited pins and logs them in generated wrapper", async () => {
    const root = await project(null);
    const inherited = path.join(root, "inherited-discovery");
    const snapshot = await runEffectiveHelper(root, {
      AGENTS_COMM_BUS_DISCOVERY_ROOT: inherited,
    });
    const wrapper = await generateAppServerWrapper(root, JSON.stringify(snapshot));
    assert.match(
      wrapper,
      new RegExp(`\\$env:AGENTS_COMM_BUS_DISCOVERY_ROOT = '${escapeRegex(inherited)}'`),
    );
    assert.match(
      wrapper,
      /Write-Host "Preserving inherited AGENTS_COMM_BUS_DISCOVERY_ROOT:/,
    );
  });

  it("marker rejected fails loud during bootstrap resolution", async () => {
    const root = await project({ daemonBin: "../../evil/serve.js" });
    const script = [
      "$ErrorActionPreference = 'Stop'",
      await loadBootstrapFunctions(),
      `$resolvedProject = ${psSingleQuoted(root)}`,
      "Resolve-DevDaemonEnvSnapshot -ProjectRoot $resolvedProject",
    ].join("; ");
    await assert.rejects(
      () =>
        run(powershellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
          cwd: REPO_ROOT,
        }),
      /Dev-config marker rejected/,
    );
  });

  it("marker present without helper fails loud instead of falling back to prod", async () => {
    const root = await project(
      { daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" },
      { includeHelper: false },
    );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      await loadBootstrapFunctions(),
      `$resolvedProject = ${psSingleQuoted(root)}`,
      "Resolve-DevDaemonEnvSnapshot -ProjectRoot $resolvedProject",
    ].join("; ");
    await assert.rejects(
      () =>
        run(powershellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
          cwd: REPO_ROOT,
        }),
      /resolve-dev-daemon-env\.mjs is missing/,
    );
  });

  it("cache-located bootstrapper resolves helper via -ProjectDir", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
      },
      { discoveryRoot: ".agents-comm-bus-discovery" },
    );
    const cacheDir = await tempRoot("acb-cbdc-cache-");
    const cacheBootstrap = path.join(cacheDir, "bootstrap-codex-session.ps1");
    await copyFile(BOOTSTRAP_SCRIPT, cacheBootstrap);
    const discovery = await runResolveFromBootstrapScript(cacheBootstrap, root, cacheDir);
    assert.equal(discovery, path.join(root, ".agents-comm-bus-discovery"));
  });

  it("cache-located bootstrapper fails loud when marker exists but helper is missing", async () => {
    const root = await project(
      { daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" },
      { includeHelper: false },
    );
    const cacheDir = await tempRoot("acb-cbdc-cache-");
    const cacheBootstrap = path.join(cacheDir, "bootstrap-codex-session.ps1");
    await copyFile(BOOTSTRAP_SCRIPT, cacheBootstrap);
    await assert.rejects(
      () => runResolveFromBootstrapScript(cacheBootstrap, root, cacheDir),
      /resolve-dev-daemon-env\.mjs is missing/,
    );
  });

  it("repo-path and cache-path bootstrapper entrypoints resolve the same discovery root", async () => {
    const root = await project(
      {
        daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
        discoveryRoot: ".agents-comm-bus-discovery",
      },
      { discoveryRoot: ".agents-comm-bus-discovery" },
    );
    const inherited = path.join(root, "terminal-inherited-discovery");
    const effective = await runEffectiveHelper(root, {
      AGENTS_COMM_BUS_DISCOVERY_ROOT: inherited,
    });
    assert.equal(
      effective.env.AGENTS_COMM_BUS_DISCOVERY_ROOT.value,
      path.join(root, ".agents-comm-bus-discovery"),
    );

    const cacheDir = await tempRoot("acb-cbdc-cache-");
    const cacheBootstrap = path.join(cacheDir, "bootstrap-codex-session.ps1");
    await copyFile(BOOTSTRAP_SCRIPT, cacheBootstrap);
    const fromRepo = await runResolveFromBootstrapScript(BOOTSTRAP_SCRIPT, root, REPO_ROOT, {
      AGENTS_COMM_BUS_DISCOVERY_ROOT: inherited,
    });
    const fromCache = await runResolveFromBootstrapScript(cacheBootstrap, root, cacheDir, {
      AGENTS_COMM_BUS_DISCOVERY_ROOT: inherited,
    });
    assert.equal(fromRepo, fromCache);
    assert.equal(fromRepo, path.join(root, ".agents-comm-bus-discovery"));
  });

  it("main bootstrap wires -DevDaemonEnvSnapshot into New-AppServerWrapper", async () => {
    const script = await readFile(BOOTSTRAP_SCRIPT, "utf8");
    const callSite = script
      .split("\n")
      .find((line) => line.includes("$wrapper = New-AppServerWrapper"));
    assert.ok(callSite, "expected a New-AppServerWrapper call site");
    assert.match(callSite!, /-DevDaemonEnvSnapshot \$script:devDaemonEnvSnapshot/);
  });

  it("repair restart relay wires DevDaemonEnvSnapshot into New-RelayScripts", async () => {
    const script = await readFile(BOOTSTRAP_SCRIPT, "utf8");
    const relayCallStart = script.indexOf("$relays = New-RelayScripts");
    assert.ok(relayCallStart >= 0, "expected New-RelayScripts call site");
    const relayCall = script.slice(relayCallStart, relayCallStart + 600);
    assert.match(relayCall, /-DevDaemonEnvSnapshot \$script:devDaemonEnvSnapshot/);
  });

  it("Exec path wires Apply-DevDaemonEnvSnapshot", async () => {
    const script = await readFile(BOOTSTRAP_SCRIPT, "utf8");
    const execBlock = script.slice(script.indexOf("if ($Exec)"));
    assert.match(execBlock, /Apply-DevDaemonEnvSnapshot -Snapshot \$script:devDaemonEnvSnapshot/);
  });
});

// AGE-84 B1: the snapshot is AUTHORITATIVE, not additive. `present:false` means
// the key was absent when the bootstrapper captured it, so it must be REMOVED
// downstream. Skipping it lets a value inherited later by the relay/wrapper
// process (e.g. another project's discovery root) silently win — the exact
// stale-inheritance failure this issue exists to remove. Preservation of
// legitimate operator pins happens at CAPTURE (`--effective` records them as
// present:true), never by ignoring absence at apply time.
describe("AGE-84 absent keys are removed, not skipped", () => {
  const ABSENT_SNAPSHOT = JSON.stringify({
    schema: SNAPSHOT_SCHEMA,
    status: "applied",
    reasons: [],
    env: Object.fromEntries(DEV_ENV_KEYS.map((key) => [key, { present: false }])),
  });

  it("in-process Exec path removes a stale inherited discovery root", async () => {
    const applied = await invokeApplyDevDaemonEnvSnapshot(ABSENT_SNAPSHOT, {
      AGENTS_COMM_BUS_DISCOVERY_ROOT: "D:\\stale-other-project",
    });
    assert.equal(
      applied.AGENTS_COMM_BUS_DISCOVERY_ROOT ?? null,
      null,
      "a key absent at capture must be removed, not left inherited",
    );
  });

  it("generated app-server wrapper emits removals for absent keys", async () => {
    const root = await project({}, {});
    const wrapper = await generateAppServerWrapper(root, ABSENT_SNAPSHOT);
    for (const key of DEV_ENV_KEYS) {
      assert.match(
        wrapper,
        new RegExp(`Remove-Item -Path "Env:${escapeRegex(key)}"`),
        `wrapper must remove ${key} when the snapshot captured it as absent`,
      );
    }
  });
});

// AGE-84 B3: the helper is resolved from the PROJECT while this bootstrapper may
// be a newer INSTALLED plugin, so the two can skew. A pre-AGE-84 helper ignores
// --effective and returns marker-only string entries; reading `.present` off
// that yields null, every key looks absent, and the snapshot silently applies
// nothing. Both the fresh helper output and the relayed JSON must be validated.
describe("AGE-84 snapshot schema validation", () => {
  async function assertShapeRejected(snapshotJson: string, expected: RegExp): Promise<void> {
    const script = [
      await loadBootstrapFunctions(),
      `$snapshot = '${snapshotJson.replace(/'/g, "''")}' | ConvertFrom-Json`,
      "try { Assert-DevDaemonEnvSnapshotShape -Snapshot $snapshot -Source 'test'; 'NO-THROW' }" +
        " catch { $_.Exception.Message }",
    ].join("; ");
    const { stdout } = await run(
      powershellPath(),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { cwd: REPO_ROOT, env: process.env },
    );
    const output = stdout.trim();
    assert.doesNotMatch(output, /NO-THROW/, "an invalid snapshot must be rejected, not accepted");
    assert.match(output, expected);
  }

  it("rejects a pre-AGE-84 marker-only helper payload", async () => {
    // Shape emitted by the OLD helper: env maps keys straight to strings.
    await assertShapeRejected(
      JSON.stringify({
        status: "applied",
        reasons: [],
        env: { AGENTS_COMM_BUS_DISCOVERY_ROOT: "D:\\some\\discovery" },
      }),
      /schema mismatch/i,
    );
  });

  it("rejects an unknown schema version", async () => {
    await assertShapeRejected(
      JSON.stringify({
        schema: "agents-comm-bus/dev-daemon-env-effective@99",
        status: "applied",
        reasons: [],
        env: Object.fromEntries(DEV_ENV_KEYS.map((key) => [key, { present: false }])),
      }),
      /schema mismatch/i,
    );
  });

  it("rejects a snapshot missing a key", async () => {
    await assertShapeRejected(
      JSON.stringify({
        schema: SNAPSHOT_SCHEMA,
        status: "applied",
        reasons: [],
        env: Object.fromEntries(
          DEV_ENV_KEYS.slice(1).map((key) => [key, { present: false }]),
        ),
      }),
      /missing key/i,
    );
  });

  // `[string]$entry.value` would coerce a number or object into a string, so a
  // malformed cross-version payload could pass the trust boundary and install
  // coerced garbage into the daemon-selection env. The contract says non-empty
  // STRING; the type must be enforced before the emptiness check.
  it("rejects present:true with a numeric value", async () => {
    await assertShapeRejected(
      JSON.stringify({
        schema: SNAPSHOT_SCHEMA,
        status: "applied",
        reasons: [],
        env: Object.fromEntries(
          DEV_ENV_KEYS.map((key) => [
            key,
            key === "AGENTS_COMM_BUS_DISCOVERY_ROOT"
              ? { present: true, value: 42 }
              : { present: false },
          ]),
        ),
      }),
      /non-string value/i,
    );
  });

  it("rejects present:true with an object value", async () => {
    await assertShapeRejected(
      JSON.stringify({
        schema: SNAPSHOT_SCHEMA,
        status: "applied",
        reasons: [],
        env: Object.fromEntries(
          DEV_ENV_KEYS.map((key) => [
            key,
            key === "AGENTS_COMM_BUS_BIN"
              ? { present: true, value: { nested: "D:\\evil" } }
              : { present: false },
          ]),
        ),
      }),
      /non-string value/i,
    );
  });

  it("rejects present:true with an empty value", async () => {
    await assertShapeRejected(
      JSON.stringify({
        schema: SNAPSHOT_SCHEMA,
        status: "applied",
        reasons: [],
        env: Object.fromEntries(
          DEV_ENV_KEYS.map((key) => [
            key,
            key === "AGENTS_COMM_BUS_BIN" ? { present: true, value: "" } : { present: false },
          ]),
        ),
      }),
      /empty value/i,
    );
  });

  // The relayed payload is written by whichever bootstrapper generated the
  // relay, which may be OLDER than the one consuming it. Validating only the
  // freshly-resolved snapshot leaves that path unguarded, so drive the real
  // script with a stale-shaped -DevDaemonEnvSnapshotJson and require a loud
  // failure rather than a silent no-op.
  it("rejects a relayed snapshot with a pre-AGE-84 shape", async () => {
    const root = await project({}, {});
    const stalePayload = JSON.stringify({
      status: "applied",
      reasons: [],
      env: { AGENTS_COMM_BUS_DISCOVERY_ROOT: "D:\\stale\\discovery" },
    });
    await assert.rejects(
      () =>
        run(
          powershellPath(),
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            BOOTSTRAP_SCRIPT,
            "-ProjectDir",
            root,
            "-PlanOnly",
            "-RestartCurrent",
            "-SameTerminal",
            "-DevDaemonEnvSnapshotJson",
            stalePayload,
          ],
          { cwd: REPO_ROOT, env: process.env },
        ),
      /schema mismatch/i,
      "a relayed snapshot from an older bootstrapper must fail loud, not silently apply nothing",
    );
  });

  it("the live helper emits the expected schema", async () => {
    const root = await project(
      { daemonBin: "agents-comm-bus/dist/core-daemon/serve.js", discoveryRoot: ".agents-comm-bus-discovery" },
      {},
    );
    const { stdout } = await run(process.execPath, [HELPER_SCRIPT, root, "--effective"], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    assert.equal(JSON.parse(stdout).schema, SNAPSHOT_SCHEMA);
  });
});
