import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stagedClaudeTelegram = join(repoRoot, "plugins/claude/telegram");
const stagedClaudeDiscord = join(repoRoot, "plugins/claude/discord");

function runVerify(outputDir: string): { exitCode: number; output: string } {
  try {
    const output = execSync(`node scripts/stage-plugins.js --verify --output-dir "${outputDir}"`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output };
  } catch (err: any) {
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    return { exitCode: err.status ?? 1, output: stdout + stderr };
  }
}

async function verifyWithClaudeManifest(mcpServers: Record<string, unknown>) {
  const outputDir = await mkdtemp(join(os.tmpdir(), "stage-plugins-verify-"));
  await cp(stagedClaudeTelegram, join(outputDir, "claude", "telegram"), { recursive: true });

  const manifestPath = join(outputDir, "claude", "telegram", ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  manifest.mcpServers = mcpServers;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  return runVerify(outputDir);
}

async function verifyWithClaudeDiscordManifest(mcpServers: Record<string, unknown>) {
  const outputDir = await mkdtemp(join(os.tmpdir(), "stage-plugins-verify-discord-"));
  await cp(stagedClaudeDiscord, join(outputDir, "claude", "discord"), { recursive: true });

  const manifestPath = join(outputDir, "claude", "discord", ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  manifest.mcpServers = mcpServers;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  return runVerify(outputDir);
}

describe("stage-plugins --verify Claude MCP manifest guards", () => {
  it("passes for the committed claude/telegram staged manifest", () => {
    const result = runVerify(join(repoRoot, "plugins"));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /\[OK\] claude\/telegram/);
  });

  it("passes for the committed claude/discord staged manifest", () => {
    const result = runVerify(join(repoRoot, "plugins"));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /\[OK\] claude\/discord/);
  });

  it("passes for the committed claude/matrix staged manifest", () => {
    const result = runVerify(join(repoRoot, "plugins"));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /\[OK\] claude\/matrix/);
  });

  it("passes for the committed codex/matrix staged manifest", () => {
    const result = runVerify(join(repoRoot, "plugins"));
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /\[OK\] codex\/matrix/);
  });

  it("fails when the staged Claude manifest has no mcpServers entry for the comm", async () => {
    const result = await verifyWithClaudeManifest({});
    assert.notEqual(result.exitCode, 0, "expected verify to fail");
    assert.match(result.output, /\[FAIL\] claude\/telegram/);
    assert.match(result.output, /mcpServers\.telegram/i);
  });

  it("fails when the staged Claude manifest keys mcpServers under the wrong comm", async () => {
    const result = await verifyWithClaudeManifest({
      discord: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/claude-mcp-shim.js"],
      },
    });
    assert.notEqual(result.exitCode, 0, "expected verify to fail");
    assert.match(result.output, /\[FAIL\] claude\/telegram/);
    assert.match(result.output, /mcpServers\.telegram/i);
  });

  it("fails when the staged Claude discord manifest has no mcpServers entry for the comm", async () => {
    const result = await verifyWithClaudeDiscordManifest({});
    assert.notEqual(result.exitCode, 0, "expected verify to fail");
    assert.match(result.output, /\[FAIL\] claude\/discord/);
    assert.match(result.output, /mcpServers\.discord/i);
  });
});
