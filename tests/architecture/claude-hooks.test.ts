import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("Claude hooks config points at Claude-named hook entrypoints", async () => {
  const hooksJson = JSON.parse(await readRepoFile("hooks/hooks.json"));

  const userPromptCommand = hooksJson.hooks.UserPromptSubmit[0].hooks[0].command;
  const permissionCommand = hooksJson.hooks.PermissionRequest[0].hooks[0].command;

  assert.equal(userPromptCommand, "node ${CLAUDE_PLUGIN_ROOT}/hooks/claude/user-prompt-submit.js");
  assert.equal(permissionCommand, "node ${CLAUDE_PLUGIN_ROOT}/hooks/claude/permission-request.js");
});

test("Claude UserPromptSubmit drains daemon inbound without legacy queue files", async () => {
  const hook = await readRepoFile("hooks/claude/user-prompt-submit.js");

  assert.match(hook, /ensureDaemon/);
  assert.match(hook, /ensureClaudeWakeWatcher/);
  assert.match(hook, /claude_register_session/);
  assert.match(hook, /claude_drain_inbound/);
  assert.match(hook, /wake_dir/);
  assert.match(hook, /chat_native_id/);
  assert.doesNotMatch(hook, /queue\.json/);
  assert.doesNotMatch(hook, /\.claude-telegram/);
});

test("Claude PermissionRequest opens daemon query without pending-permission file", async () => {
  const hook = await readRepoFile("hooks/claude/permission-request.js");

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

test("Claude wake support uses daemon wake directory and watcher pid marker", async () => {
  const hook = await readRepoFile("hooks/claude/wake-support.js");

  assert.match(hook, /claudeWakeDirForProject/);
  assert.match(hook, /watcher\.pid/);
  assert.match(hook, /enter-watcher\.ps1/);
  assert.doesNotMatch(hook, /\.claude-telegram/);
});

test("legacy Claude hook paths are compatibility wrappers only", async () => {
  const userPromptWrapper = await readRepoFile("hooks/telegram-context.js");
  const permissionWrapper = await readRepoFile("hooks/permission-telegram.cjs");

  assert.match(userPromptWrapper, /claude\/user-prompt-submit\.js/);
  assert.match(permissionWrapper, /claude\/permission-request\.js/);
  assert.doesNotMatch(userPromptWrapper, /queue\.json/);
  assert.doesNotMatch(permissionWrapper, /pending-permission\.json/);
});
