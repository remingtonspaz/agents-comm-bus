import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("Codex UserPromptSubmit drains daemon inbound without legacy queue files", async () => {
  const hook = await readRepoFile("hooks/codex/user-prompt-submit.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /codex_register_session/);
  assert.match(hook, /codex_drain_inbound/);
  assert.match(hook, /CODEX_APP_SERVER_URL/);
  assert.doesNotMatch(hook, /queue\.json/);
  assert.doesNotMatch(hook, /\.codex-telegram/);
});

test("Codex PermissionRequest opens daemon query without pending-permission files", async () => {
  const hook = await readRepoFile("hooks/codex/permission-request.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /codex_register_session/);
  assert.match(hook, /codex_open_query/);
  assert.match(hook, /PermissionRequest/);
  assert.match(hook, /hookSpecificOutput/);
  assert.doesNotMatch(hook, /pending-permission\.json/);
  assert.doesNotMatch(hook, /permission-response\.json/);
  assert.doesNotMatch(hook, /\.codex-telegram/);
});

test("Codex SessionStart schedules bootstrap restart through daemon status", async () => {
  const hook = await readRepoFile("hooks/codex/session-start.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /codex_bootstrap_status/);
  assert.match(hook, /AGENTS_COMM_BUS_SESSION_ID/);
  assert.match(hook, /app_server_reachable/);
  assert.match(hook, /canReachAppServer/);
  assert.match(hook, /codexThreadId/);
  assert.match(hook, /const threadId = codexThreadId\(hookInput\)/);
  assert.match(hook, /bootstrap-codex-session\.ps1/);
  assert.match(hook, /RestartCurrent/);
  assert.match(hook, /SameTerminal/);
  assert.match(hook, /args\.push\('-ThreadId', String\(threadId\)\)/);
  assert.match(hook, /RESTART_GUARD_MS/);
  assert.doesNotMatch(hook, /\.codex-telegram/);
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

test("Codex installer uses Codex MCP shim without --agent split", async () => {
  const installer = await readRepoFile("install-codex.js");

  assert.match(installer, /codex-mcp-shim/);
  assert.match(installer, /mcp-server/);
  assert.match(installer, /dist/);
  assert.match(installer, /SessionStart/);
  assert.match(installer, /session-start\.js/);
  assert.doesNotMatch(installer, /--agent=codex/);
  assert.doesNotMatch(installer, /\.codex-telegram/);
});

test("Codex MCP shim owns Codex metadata inference", async () => {
  const shim = await readRepoFile("hosts/codex/codex-mcp-shim.js");
  const shared = await readRepoFile("hosts/common/mcp-shim-shared.js");

  assert.match(shim, /function agentInUse/);
  assert.match(shim, /CODEX_APP_SERVER_URL/);
  assert.match(shim, /CODEX_SESSION_ID/);
  assert.match(shim, /CODEX_THREAD_ID/);
  assert.match(shim, /replace_existing_lease/);
  assert.match(shim, /manage_app_server_lifecycle/);
  assert.doesNotMatch(shared, /function agentInUse/);
});

test("Codex plugin manifest describes daemon-backed runtime", async () => {
  const manifest = JSON.parse(await readRepoFile(".codex-plugin/plugin.json"));

  assert.equal(manifest.name, "telegram");
  assert.match(manifest.description, /agents-comm-bus/);
  assert.equal(manifest.mcpServers.telegram.command, "node");
  assert.deepEqual(manifest.mcpServers.telegram.args, ["${CODEX_PLUGIN_ROOT}/mcp-server/dist/codex-mcp-shim.js"]);
  assert.match(manifest.interface.longDescription, /shared agents-comm-bus daemon/);
});
