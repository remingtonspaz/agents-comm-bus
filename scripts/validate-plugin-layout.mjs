#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMM_IMPLEMENTATION_STATUS,
  SUPPORTED_AGENTS,
  SUPPORTED_COMMS,
} from "./build-plugin-artifacts.js";

export const AGENTS = SUPPORTED_AGENTS;
export const COMMS = SUPPORTED_COMMS;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, "..");

export function pluginRoot(repoRoot, agent, comm) {
  return path.join(repoRoot, "plugins", agent, comm);
}

function shimFileName(agent, comm) {
  const implemented = COMM_IMPLEMENTATION_STATUS[comm] === "implemented";
  if (implemented) {
    return agent === "claude" ? "claude-mcp-shim.js" : "codex-mcp-shim.js";
  }
  return `${comm}-scaffold-mcp-shim.js`;
}

export function requiredFilesFor(agent, comm) {
  const shared = [
    "daemon.bundle.js",
    `${comm}.adapter.bundle.js`,
    `skills/${comm}.md`,
    "hooks/session-start.js",
    "hooks/hooks.json",
    "storage/schema/001_initial.sql",
    "storage/schema/004_session_owner_process.sql",
  ];

  if (agent === "claude") {
    return [...shared, shimFileName(agent, comm), ".claude-plugin/plugin.json"];
  }

  return [...shared, shimFileName(agent, comm), ".codex-plugin/plugin.json", ".mcp.json"];
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function validateManifest(repoRoot, agent, comm, failures) {
  const root = pluginRoot(repoRoot, agent, comm);
  const expectedName = `agents-comm-bus-${comm}`;
  const expectedShimPath = agent === "claude"
    ? `\${CLAUDE_PLUGIN_ROOT}/${shimFileName(agent, comm)}`
    : `\${CODEX_PLUGIN_ROOT}/${shimFileName(agent, comm)}`;

  if (agent === "claude") {
    const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const mcpServer = manifest.mcpServers?.[comm];

    assert.equal(manifest.name, expectedName, `${manifestPath} name mismatch`);
    assert.match(manifest.version, /\S/, `${manifestPath} version missing`);
    assert.match(manifest.description, /agents-comm-bus/, `${manifestPath} description mismatch`);
    assert.equal(mcpServer?.command, "node", `${manifestPath} Claude MCP command mismatch`);
    assert.equal(mcpServer?.args?.[0], expectedShimPath, `${manifestPath} Claude MCP arg mismatch`);
    return;
  }

  const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const mcpConfigPath = path.join(root, ".mcp.json");
  const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  const mcpServer = mcpConfig.mcpServers?.[comm];

  assert.equal(manifest.name, expectedName, `${manifestPath} name mismatch`);
  assert.match(manifest.version, /\S/, `${manifestPath} version missing`);
  assert.match(manifest.description, /agents-comm-bus/, `${manifestPath} description mismatch`);
  assert.equal(manifest.skills, "./skills/", `${manifestPath} Codex skill directory mismatch`);
  assert.equal(mcpServer?.command, "node", `${mcpConfigPath} Codex MCP command mismatch`);
  assert.equal(mcpServer?.args?.[0], expectedShimPath, `${mcpConfigPath} Codex MCP arg mismatch`);

  const skill = await readFile(path.join(root, "skills", `${comm}.md`), "utf8");
  const expectedStatus = COMM_IMPLEMENTATION_STATUS[comm] === "implemented" ? "implemented" : "scaffold-only";
  if (!skill.includes(`Status: ${expectedStatus}`)) {
    failures.push(`${path.join(root, "skills", `${comm}.md`)} status should be ${expectedStatus}`);
  }
}

export async function validatePluginLayout(repoRoot = defaultRepoRoot) {
  const failures = [];

  for (const agent of AGENTS) {
    for (const comm of COMMS) {
      const root = pluginRoot(repoRoot, agent, comm);

      for (const relativePath of requiredFilesFor(agent, comm)) {
        const targetPath = path.join(root, relativePath);
        if (!(await fileExists(targetPath))) {
          failures.push(`missing required file: ${path.relative(repoRoot, targetPath)}`);
        }
      }

      if (failures.some((failure) => failure.includes(path.relative(repoRoot, root)))) {
        continue;
      }

      try {
        await validateManifest(repoRoot, agent, comm, failures);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = await validatePluginLayout();
  if (failures.length > 0) {
    console.error("Plugin artifact layout validation failed:\n");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${AGENTS.length * COMMS.length} plugin artifact directories.`);
}
