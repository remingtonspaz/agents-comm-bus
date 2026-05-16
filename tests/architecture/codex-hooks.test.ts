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

test("Codex installer uses shared MCP shim without --agent split", async () => {
  const installer = await readRepoFile("install-codex.js");

  assert.match(installer, /mcp-server/);
  assert.match(installer, /dist/);
  assert.match(installer, /AGENTS_COMM_BUS_AGENT/);
  assert.match(installer, /CODEX_APP_SERVER_URL/);
  assert.doesNotMatch(installer, /--agent=codex/);
  assert.doesNotMatch(installer, /\.codex-telegram/);
});

test("shared MCP shim can infer Codex metadata from Codex env", async () => {
  const shim = await readRepoFile("mcp-server/server.js");

  assert.match(shim, /function agentInUse/);
  assert.match(shim, /CODEX_APP_SERVER_URL/);
  assert.match(shim, /CODEX_SESSION_ID/);
  assert.match(shim, /CODEX_THREAD_ID/);
});

test("Codex plugin manifest describes daemon-backed runtime", async () => {
  const manifest = JSON.parse(await readRepoFile(".codex-plugin/plugin.json"));

  assert.equal(manifest.name, "telegram");
  assert.match(manifest.description, /agents-comm-bus/);
  assert.equal(manifest.mcpServers.telegram.command, "node");
  assert.match(manifest.interface.longDescription, /shared agents-comm-bus daemon/);
});
