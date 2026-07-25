import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { accountLabelScopeFromEnvSafe } from "../../hosts/common/comm-labels.js";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.join(fileURLToPath(import.meta.url), "../../.."));
const BOOTSTRAP_SCRIPT = path.join(REPO_ROOT, "scripts/bootstrap-codex-session.ps1");
const SCOPE_INERT_SENTINEL = '{"__agents_comm_invalid__":"invalid"}';

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psSingleQuoted(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function childEnv(agentsCommLabels?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (agentsCommLabels === undefined) {
    delete env.AGENTS_COMM_LABELS;
  } else {
    env.AGENTS_COMM_LABELS = agentsCommLabels;
  }
  return env;
}

async function runPlanOnlyRestart(options: {
  agentsCommLabelsFlag?: string;
  envAgentsCommLabels?: string;
}): Promise<{ relayPath?: string }> {
  const flagArg =
    options.agentsCommLabelsFlag === undefined
      ? ""
      : `-AgentsCommLabels ${psSingleQuoted(options.agentsCommLabelsFlag)}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$plan = & ${psSingleQuoted(BOOTSTRAP_SCRIPT)} -ProjectDir ${psSingleQuoted(REPO_ROOT)} -RestartCurrent -SameTerminal -PlanOnly -Exec -Json -KillPid $PID ${flagArg} | ConvertFrom-Json`,
    "$plan | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await run(
    powershellPath(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: REPO_ROOT,
      env: childEnv(options.envAgentsCommLabels),
    },
  );
  return JSON.parse(stdout.trim()) as { relayPath?: string };
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

async function generateAppServerWrapper(labels: string): Promise<string> {
  const pidFile = path.join(os.tmpdir(), "codex-test.pid");
  const script = [
    await loadBootstrapFunctions(),
    `$wrapperPath = New-AppServerWrapper -Project ${psSingleQuoted(REPO_ROOT)} -Url 'ws://127.0.0.1:4501' -Session 'codex_test_session' -Command 'codex' -PidFile ${psSingleQuoted(pidFile)} -Thread '' -Labels ${psSingleQuoted(labels)}`,
    "Get-Content -LiteralPath $wrapperPath -Raw",
  ].join("; ");
  const { stdout } = await run(
    powershellPath(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: REPO_ROOT, env: process.env },
  );
  return stdout;
}

async function invokeSetAgentsCommLabelsEnvironment(
  labels: string,
  preset?: string,
): Promise<{ present: boolean; value?: string }> {
  const presetLine =
    preset === undefined
      ? ""
      : `$env:AGENTS_COMM_LABELS = ${psSingleQuoted(preset)}`;
  const script = [
    await loadBootstrapFunctions(),
    presetLine,
    `Set-AgentsCommLabelsEnvironment -Labels ${psSingleQuoted(labels)}`,
    "[ordered]@{ present = (Test-Path Env:AGENTS_COMM_LABELS); value = $env:AGENTS_COMM_LABELS } | ConvertTo-Json -Compress",
  ]
    .filter(Boolean)
    .join("; ");
  const { stdout } = await run(
    powershellPath(),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: REPO_ROOT, env: process.env },
  );
  return JSON.parse(stdout.trim()) as { present: boolean; value?: string };
}

async function readRelayScript(relayPath: string): Promise<string> {
  const relay = await readFile(relayPath, "utf8");
  const ps1Match = relay.match(/-File "([^"]+\.ps1)"/i);
  if (ps1Match) {
    return await readFile(ps1Match[1], "utf8");
  }
  return relay;
}

describe("Codex bootstrap AGENTS_COMM_LABELS forwarding", () => {
  it("generated app-server wrapper sets AGENTS_COMM_LABELS for a labelled bootstrap", async () => {
    const wrapper = await generateAppServerWrapper("telegram:main");
    assert.match(wrapper, /\$env:AGENTS_COMM_LABELS = 'telegram:main'/);
    assert.match(wrapper, /if \(-not \[string\]::IsNullOrWhiteSpace\('telegram:main'\)\)/);
  });

  it("generated app-server wrapper removes AGENTS_COMM_LABELS when unlabeled", async () => {
    const wrapper = await generateAppServerWrapper("");
    assert.match(wrapper, /Remove-Item Env:AGENTS_COMM_LABELS -ErrorAction SilentlyContinue/);
    assert.match(wrapper, /if \(-not \[string\]::IsNullOrWhiteSpace\(''\)\)/);
  });

  it("generated app-server wrapper forwards malformed labels unchanged (scope-inert, not unlabeled)", async () => {
    const malformed = "telegram:";
    const wrapper = await generateAppServerWrapper(malformed);
    assert.match(wrapper, /\$env:AGENTS_COMM_LABELS = 'telegram:'/);
    assert.match(wrapper, /if \(-not \[string\]::IsNullOrWhiteSpace\('telegram:'\)\)/);
    assert.equal(
      accountLabelScopeFromEnvSafe({ AGENTS_COMM_LABELS: malformed }, () => {}),
      SCOPE_INERT_SENTINEL,
    );
    assert.notEqual(accountLabelScopeFromEnvSafe({ AGENTS_COMM_LABELS: malformed }, () => {}), null);
  });

  it("generated app-server wrapper quotes labels containing single quotes", async () => {
    const wrapper = await generateAppServerWrapper("telegram:consultant's");
    assert.match(wrapper, /\$env:AGENTS_COMM_LABELS = 'telegram:consultant''s'/);
  });

  it("Set-AgentsCommLabelsEnvironment sets AGENTS_COMM_LABELS for labelled Exec path", async () => {
    const result = await invokeSetAgentsCommLabelsEnvironment("telegram:main");
    assert.equal(result.present, true);
    assert.equal(result.value, "telegram:main");
  });

  it("Set-AgentsCommLabelsEnvironment removes stale AGENTS_COMM_LABELS when unlabeled", async () => {
    const result = await invokeSetAgentsCommLabelsEnvironment("", "telegram:stale");
    assert.equal(result.present, false);
    assert.equal(result.value, null);
  });

  it("Exec path wires Set-AgentsCommLabelsEnvironment for Codex client env", async () => {
    const script = await readFile(BOOTSTRAP_SCRIPT, "utf8");
    const execBlock = script.slice(script.indexOf("if ($Exec)"));
    assert.match(execBlock, /Set-AgentsCommLabelsEnvironment -Labels \$AgentsCommLabels/);
  });

  // The wrapper unit tests call New-AppServerWrapper directly with -Labels, so they
  // cannot notice the production call site dropping the argument. Without this test,
  // the normal (non-Exec) bootstrap could launch an unlabelled app-server while the
  // whole suite stayed green.
  it("main bootstrap wires -Labels into New-AppServerWrapper", async () => {
    const script = await readFile(BOOTSTRAP_SCRIPT, "utf8");
    const callSite = script
      .split("\n")
      .find((line) => line.includes("$wrapper = New-AppServerWrapper"));
    assert.ok(callSite, "expected a New-AppServerWrapper call site");
    assert.match(callSite!, /-Labels \$AgentsCommLabels/);
  });

  it("repair restart relay reads AgentsCommLabels from process env when flag omitted", async () => {
    const plan = await runPlanOnlyRestart({ envAgentsCommLabels: "telegram:main" });
    assert.ok(plan.relayPath, "expected relayPath in PlanOnly JSON output");
    const relay = await readRelayScript(plan.relayPath!);
    assert.match(relay, /\$paramsForBootstrapper\.AgentsCommLabels = 'telegram:main'/);
    assert.match(relay, /\$paramsForBootstrapper\.Exec = \$true/);
  });

  it("repair restart relay serializes empty AgentsCommLabels from absent env explicitly", async () => {
    const plan = await runPlanOnlyRestart({});
    assert.ok(plan.relayPath, "expected relayPath in PlanOnly JSON output");
    const relay = await readRelayScript(plan.relayPath!);
    assert.match(relay, /\$paramsForBootstrapper\.AgentsCommLabels = ''/);
  });

  it("repair restart relay serializes empty AgentsCommLabels from empty env explicitly", async () => {
    const plan = await runPlanOnlyRestart({ envAgentsCommLabels: "" });
    assert.ok(plan.relayPath, "expected relayPath in PlanOnly JSON output");
    const relay = await readRelayScript(plan.relayPath!);
    assert.match(relay, /\$paramsForBootstrapper\.AgentsCommLabels = ''/);
  });

  it("explicit -AgentsCommLabels flag wins over ambient env on repair restart relay", async () => {
    const plan = await runPlanOnlyRestart({
      envAgentsCommLabels: "telegram:ambient",
      agentsCommLabelsFlag: "telegram:explicit",
    });
    assert.ok(plan.relayPath, "expected relayPath in PlanOnly JSON output");
    const relay = await readRelayScript(plan.relayPath!);
    assert.match(relay, /\$paramsForBootstrapper\.AgentsCommLabels = 'telegram:explicit'/);
    assert.doesNotMatch(relay, /telegram:ambient/);
  });
});
