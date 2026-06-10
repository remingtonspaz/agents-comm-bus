import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

import {
  enterWatcherScriptCandidates,
  resolveEnterWatcherScript,
} from "../../hosts/claude/hooks/wake-support.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

async function listClaudePluginComms(): Promise<string[]> {
  const dir = path.join(repoRoot, "plugins/claude");
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function assertPathExists(targetPath: string): Promise<void> {
  await access(targetPath);
}

describe("Claude MCP shim enter-watcher.ps1 resolution", () => {
  it("mcp-server/dist shim resolves repo scripts/", async () => {
    const shimDir = path.join(repoRoot, "mcp-server/dist");
    const expected = path.join(repoRoot, "scripts", "enter-watcher.ps1");
    await assertPathExists(expected);
    assert.equal(resolveEnterWatcherScript(shimDir), expected);
  });

  it("each bundled claude-mcp-shim.js __dirname resolves an existing enter-watcher.ps1", async () => {
    const comms = await listClaudePluginComms();
    const shimPaths = [
      path.join(repoRoot, "mcp-server/dist/claude-mcp-shim.js"),
      ...comms.map((comm) => path.join(repoRoot, "plugins/claude", comm, "claude-mcp-shim.js")),
    ];

    for (const shimPath of shimPaths) {
      const shimDir = path.dirname(shimPath);
      await assertPathExists(shimPath);
      const resolved = resolveEnterWatcherScript(shimDir);
      assert.ok(resolved, `no candidate resolved for ${path.relative(repoRoot, shimDir)}`);
      await assertPathExists(resolved);
    }
  });

  it("staged plugin shims resolve artifact-local scripts/, not repo scripts/", async () => {
    const comms = await listClaudePluginComms();
    const repoScripts = path.join(repoRoot, "scripts", "enter-watcher.ps1");
    await assertPathExists(repoScripts);

    for (const comm of comms) {
      const shimDir = path.join(repoRoot, "plugins/claude", comm);
      const artifactLocal = path.join(shimDir, "scripts", "enter-watcher.ps1");
      await assertPathExists(artifactLocal);

      const resolved = resolveEnterWatcherScript(shimDir);
      assert.equal(
        resolved,
        artifactLocal,
        `${comm}: must resolve via shim __dirname/scripts, not ${path.relative(repoRoot, repoScripts)}`,
      );

      const candidates = enterWatcherScriptCandidates(shimDir);
      const artifactIndex = candidates.indexOf(artifactLocal);
      const repoIndex = candidates.indexOf(repoScripts);
      assert.ok(artifactIndex >= 0);
      assert.ok(repoIndex >= 0);
      assert.ok(
        artifactIndex < repoIndex,
        `${comm}: artifact-local candidate must precede repo/scripts fallback`,
      );
    }
  });

  it("source hook tree still resolves repo scripts/", async () => {
    const hookDir = path.join(repoRoot, "hosts/claude/hooks");
    const expected = path.join(repoRoot, "scripts", "enter-watcher.ps1");
    await assertPathExists(expected);
    assert.equal(resolveEnterWatcherScript(hookDir), expected);
  });
});
