import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const artifactRoot = path.join(repoRoot, "plugins/codex/telegram");

async function readArtifactFile(relativePath: string): Promise<string> {
  return readFile(path.join(artifactRoot, relativePath), "utf8");
}

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("Codex staged UserPromptSubmit drains daemon inbound without legacy queue files", async () => {
  const hook = await readArtifactFile("hooks/user-prompt-submit.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /codex_register_session/);
  assert.match(hook, /codex_drain_inbound/);
  assert.match(hook, /CODEX_APP_SERVER_URL/);
  assert.doesNotMatch(hook, /queue\.json/);
  assert.doesNotMatch(hook, /\.codex-telegram/);
});

test("Codex staged PermissionRequest opens daemon query without pending-permission files", async () => {
  const hook = await readArtifactFile("hooks/permission-request.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /codex_register_session/);
  assert.match(hook, /codex_open_query/);
  assert.match(hook, /PermissionRequest/);
  assert.match(hook, /hookSpecificOutput/);
  assert.doesNotMatch(hook, /pending-permission\.json/);
  assert.doesNotMatch(hook, /permission-response\.json/);
  assert.doesNotMatch(hook, /\.codex-telegram/);
});

test("Codex staged SessionStart schedules bootstrap restart through daemon status", async () => {
  const hook = await readArtifactFile("hooks/session-start.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /codex_bootstrap_status/);
  assert.match(hook, /AGENTS_COMM_BUS_SESSION_ID/);
  assert.match(hook, /app_server_reachable/);
  assert.match(hook, /canReachAppServer/);
  assert.match(hook, /codexThreadId/);
  assert.match(hook, /const threadId = codexThreadId\(hookInput\)/);
  assert.match(hook, /bootstrap-codex-session\.ps1/);
  assert.match(hook, /'-ProjectDir'/);
  assert.match(hook, /scheduleBootstrapRestart\(project, threadId\)/);
  assert.match(hook, /cwd: project/);
  assert.match(hook, /RestartCurrent/);
  assert.match(hook, /SameTerminal/);
  assert.match(hook, /args\.push\('-ThreadId', String\(threadId\)\)/);
  assert.match(hook, /RESTART_GUARD_MS/);
  assert.doesNotMatch(hook, /\.codex-telegram/);
});

test("Codex staged SessionStart resolves bootstrapper from artifact-local scripts directory", async () => {
  await access(path.join(artifactRoot, "scripts/bootstrap-codex-session.ps1"));
  const hook = await readArtifactFile("hooks/session-start.js");
  assert.match(
    hook,
    /const bootstrapperPath = path\.join\(__dirname, '\.\.', 'scripts', 'bootstrap-codex-session\.ps1'\)/
  );
});

test("Codex bridge exposes bootstrap status IPC for SessionStart", async () => {
  const bridge = await readRepoFile("core-daemon/bridges/codex/bridge.ts");

  assert.match(bridge, /codex_bootstrap_status/);
  assert.match(bridge, /bootstrapStatus/);
  assert.match(bridge, /listAccountRegistrations/);
  assert.match(bridge, /managed_session_id/);
  assert.match(bridge, /app_server_reachable/);
  assert.match(bridge, /bootstrap_required/);
});

test("Codex staged hooks use artifact-local shimNames", async () => {
  const userPrompt = await readArtifactFile("hooks/user-prompt-submit.js");
  const permission = await readArtifactFile("hooks/permission-request.js");
  const sessionStart = await readArtifactFile("hooks/session-start.js");

  assert.match(userPrompt, /shimName: '\.\/hooks\/user-prompt-submit\.js'/);
  assert.match(permission, /shimName: '\.\/hooks\/permission-request\.js'/);
  assert.match(sessionStart, /shimName: '\.\/hooks\/session-start\.js'/);
});

test("Codex staged MCP shim owns Codex metadata inference", async () => {
  const shim = await readArtifactFile("codex-mcp-shim.js");
  const shared = await readRepoFile("hosts/common/mcp-shim-shared.js");

  assert.match(shim, /function agentInUse/);
  assert.match(shim, /CODEX_APP_SERVER_URL/);
  assert.match(shim, /CODEX_SESSION_ID/);
  assert.match(shim, /CODEX_THREAD_ID/);
  assert.match(shim, /replace_existing_lease/);
  assert.match(shim, /manage_app_server_lifecycle/);
  assert.doesNotMatch(shared, /function agentInUse/);
});

test("Codex staged plugin manifest is self-contained and leaves MCP config to .mcp.json", async () => {
  const manifest = JSON.parse(await readArtifactFile(".codex-plugin/plugin.json"));

  assert.equal(manifest.name, "telegram");
  assert.match(manifest.description, /agents-comm-bus/);
  assert.equal(manifest.mcpServers, undefined);
  assert.match(manifest.interface.longDescription, /shared agents-comm-bus daemon/);
});

test("Codex staged manifest does not leak source paths", async () => {
  const manifest = JSON.parse(await readArtifactFile(".codex-plugin/plugin.json"));
  const manifestStr = JSON.stringify(manifest);
  assert.doesNotMatch(manifestStr, /hosts\/codex/);
  assert.doesNotMatch(manifestStr, /mcp-server\/dist/);
  assert.doesNotMatch(manifestStr, /\$\{CODEX_PLUGIN_ROOT\}/);
});

test("Codex staged hooks do not import from source paths", async () => {
  const entries = await readdir(path.join(artifactRoot, "hooks"), { withFileTypes: true });
  const jsFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".js"));
  for (const f of jsFiles) {
    const content = await readArtifactFile(`hooks/${f.name}`);
    assert.doesNotMatch(content, /from ['"]\.\.\/..\/hosts\/codex\//);
    assert.doesNotMatch(content, /from ['"]hosts\/codex\//);
  }
});

test("Codex staged .mcp.json is standalone with local paths", async () => {
  const mcp = JSON.parse(await readArtifactFile(".mcp.json"));
  assert.equal(mcp.mcpServers.telegram.command, "node");
  assert.deepEqual(mcp.mcpServers.telegram.args, ["./codex-mcp-shim.js"]);
  const mcpStr = JSON.stringify(mcp);
  assert.doesNotMatch(mcpStr, /hosts\/codex/);
  assert.doesNotMatch(mcpStr, /mcp-server\/dist/);
  assert.doesNotMatch(mcpStr, /\$\{CODEX_PLUGIN_ROOT\}/);
});

test("dev installer is distinct from staged artifact", async () => {
  await assert.rejects(access(path.join(artifactRoot, "install-codex.js")), { code: "ENOENT" });
});
