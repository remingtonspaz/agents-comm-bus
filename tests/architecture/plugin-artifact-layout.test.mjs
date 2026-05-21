import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENTS, COMMS, pluginRoot, validatePluginLayout } from "../../scripts/validate-plugin-layout.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("plugin artifact matrix exists for every agent and comm", async () => {
  const failures = await validatePluginLayout(repoRoot);
  assert.deepEqual(failures, []);
});

test("plugin artifact matrix covers the full supported grid", () => {
  const expectedRoots = AGENTS.flatMap((agent) => COMMS.map((comm) => path.relative(repoRoot, pluginRoot(repoRoot, agent, comm))));

  assert.deepEqual(expectedRoots, [
    "plugins/claude/telegram",
    "plugins/claude/matrix",
    "plugins/claude/discord",
    "plugins/claude/slack",
    "plugins/codex/telegram",
    "plugins/codex/matrix",
    "plugins/codex/discord",
    "plugins/codex/slack",
  ]);
});