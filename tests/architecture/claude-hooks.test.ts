import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const artifactRoot = path.join(repoRoot, "plugins/claude/telegram");

async function readArtifactFile(relativePath: string): Promise<string> {
  return readFile(path.join(artifactRoot, relativePath), "utf8");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

test("Claude artifact hooks config points at artifact-local hook entrypoints", async () => {
  const hooksJson = JSON.parse(await readArtifactFile("hooks/hooks.json"));

  const userPromptCommand = hooksJson.hooks.UserPromptSubmit[0].hooks[0].command;
  const permissionCommand = hooksJson.hooks.PermissionRequest[0].hooks[0].command;
  const sessionStartCommand = hooksJson.hooks.SessionStart[0].hooks[0].command;

  assert.equal(userPromptCommand, "node ./hooks/user-prompt-submit.js");
  assert.equal(permissionCommand, "node ./hooks/permission-request.js");
  assert.equal(sessionStartCommand, "node ./hooks/session-start.js");
});

test("Claude staged UserPromptSubmit drains daemon inbound without legacy queue files", async () => {
  const hook = await readArtifactFile("hooks/user-prompt-submit.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /ensureClaudeWakeWatcher/);
  assert.match(hook, /claude_register_session/);
  assert.match(hook, /claude_drain_inbound/);
  assert.match(hook, /wake_dir/);
  assert.match(hook, /chat_native_id/);
  assert.doesNotMatch(hook, /queue\.json/);
  assert.doesNotMatch(hook, /\.claude-telegram/);
});

test("Claude staged PermissionRequest opens daemon query without pending-permission file", async () => {
  const hook = await readArtifactFile("hooks/permission-request.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /claude_register_session/);
  assert.match(hook, /claude_open_query/);
  assert.match(hook, /wake_dir/);
  assert.match(hook, /AskUserQuestion/);
  assert.match(hook, /ExitPlanMode/);
  assert.match(hook, /EnterPlanMode/);
  assert.doesNotMatch(hook, /pending-permission\.json/);
  assert.doesNotMatch(hook, /\.claude-telegram/);
});

test("Claude staged wake support uses daemon wake directory and watcher pid marker", async () => {
  const hook = await readArtifactFile("hooks/wake-support.js");

  assert.match(hook, /claudeWakeDirForProject/);
  assert.match(hook, /watcher\.pid/);
  assert.match(hook, /enter-watcher\.ps1/);
  assert.match(hook, /path\.resolve\(__dirname, '\.\.', 'scripts', 'enter-watcher\.ps1'\)/);
  assert.doesNotMatch(hook, /\.claude-telegram/);
});

test("Claude staged wake support resolves watcher script from artifact-local scripts directory", async () => {
  await access(path.join(artifactRoot, "scripts/enter-watcher.ps1"));
});

test("Claude staged hooks use artifact-local shimNames", async () => {
  const userPrompt = await readArtifactFile("hooks/user-prompt-submit.js");
  const permission = await readArtifactFile("hooks/permission-request.js");

  assert.match(userPrompt, /shimName: '\.\/hooks\/user-prompt-submit\.js'/);
  assert.match(permission, /shimName: '\.\/hooks\/permission-request\.js'/);
});

test("legacy root Claude compatibility wrapper paths are removed", async () => {
  await assert.rejects(access(path.join(repoRoot, "hooks/telegram-context.js")), { code: "ENOENT" });
  await assert.rejects(access(path.join(repoRoot, "hooks/permission-telegram.cjs")), { code: "ENOENT" });
  await assert.rejects(access(path.join(repoRoot, "hooks/session-start.js")), { code: "ENOENT" });
});

test("Claude staged plugin manifest is self-contained with local MCP shim path", async () => {
  const manifest = JSON.parse(await readArtifactFile(".claude-plugin/plugin.json"));

  assert.equal(manifest.name, "telegram");
  assert.equal(manifest.mcpServers.telegram.command, "node");
  // Manifest in artifact must use artifact-local relative path
  assert.deepEqual(manifest.mcpServers.telegram.args, ["./claude-mcp-shim.js"]);
  assert.ok(manifest.skills?.endsWith("skills/"), "skills field points to ./skills/");
});

test("Claude staged manifest does not leak source paths", async () => {
  const manifest = JSON.parse(await readArtifactFile(".claude-plugin/plugin.json"));
  const manifestStr = JSON.stringify(manifest);
  assert.doesNotMatch(manifestStr, /hosts\/claude/);
  assert.doesNotMatch(manifestStr, /mcp-server\/dist/);
  assert.doesNotMatch(manifestStr, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test("Claude staged hooks do not import from source paths", async () => {
  const entries = await readdir(path.join(artifactRoot, "hooks"), { withFileTypes: true });
  const jsFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".js"));
  for (const f of jsFiles) {
    const content = await readArtifactFile(`hooks/${f.name}`);
    assert.doesNotMatch(content, /from ['"]\.\.\/..\/hosts\/claude\//);
    assert.doesNotMatch(content, /from ['"]hosts\/claude\//);
  }
});
