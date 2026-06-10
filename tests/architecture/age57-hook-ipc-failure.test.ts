import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  AGENTS_COMM_BUS_DEGRADED_MESSAGE,
  degradedHookOutput,
} from "../../hosts/common/hook-degraded.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("AGE-57 degraded hook helper exposes systemMessage and additionalContext", () => {
  const output = degradedHookOutput("UserPromptSubmit");
  assert.equal(output.systemMessage, AGENTS_COMM_BUS_DEGRADED_MESSAGE);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(output.hookSpecificOutput.additionalContext, AGENTS_COMM_BUS_DEGRADED_MESSAGE);
  assert.match(AGENTS_COMM_BUS_DEGRADED_MESSAGE, /daemon unreachable/);
});

test("AGE-57 Claude UserPromptSubmit surfaces degraded message on IPC failure path", async () => {
  const hook = await readFile(
    path.join(repoRoot, "hosts/claude/hooks/user-prompt-submit.js"),
    "utf8",
  );
  assert.match(hook, /AGENTS_COMM_BUS_DEGRADED_MESSAGE/);
  assert.match(hook, /systemMessage:\s*AGENTS_COMM_BUS_DEGRADED_MESSAGE/);
  assert.match(hook, /additionalContext:\s*AGENTS_COMM_BUS_DEGRADED_MESSAGE/);
});

test("AGE-57 Claude PermissionRequest surfaces degraded systemMessage on IPC failure path", async () => {
  const hook = await readFile(
    path.join(repoRoot, "hosts/claude/hooks/permission-request.js"),
    "utf8",
  );
  assert.match(hook, /AGENTS_COMM_BUS_DEGRADED_MESSAGE/);
  assert.match(hook, /systemMessage:\s*AGENTS_COMM_BUS_DEGRADED_MESSAGE/);
});

test("AGE-57 Codex hooks surface degraded message on IPC failure path", async () => {
  const userPrompt = await readFile(
    path.join(repoRoot, "hosts/codex/hooks/user-prompt-submit.js"),
    "utf8",
  );
  const permission = await readFile(
    path.join(repoRoot, "hosts/codex/hooks/permission-request.js"),
    "utf8",
  );
  assert.match(userPrompt, /AGENTS_COMM_BUS_DEGRADED_MESSAGE/);
  assert.match(permission, /AGENTS_COMM_BUS_DEGRADED_MESSAGE/);
});
