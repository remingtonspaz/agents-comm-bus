#!/usr/bin/env node
// install-codex.js - wires the shared Telegram MCP shim into Codex config.
//
// Codex does not consume the Claude plugin manifest. This installer writes a
// path-only MCP server entry into ~/.codex/config.toml and project-local hooks
// into <project>/.codex/config.toml. Runtime Telegram ownership still lives in
// the shared agents-comm-bus daemon.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { formatTomlEnvVars } from './hosts/codex/mcp-env-vars.js';
import { prepareShellEnvFilter } from './hosts/codex/install-shell-env-filter.js';
import {
  assertCanonicalProjectEnvVars,
  findTableRange,
  hasProjectMcpDeclaration,
  spliceLines,
  syncProjectMcpEnvVars,
} from './hosts/codex/install-codex-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const MCP_ONLY = process.argv.includes('--mcp-only');
const HOOKS_ONLY = process.argv.includes('--hooks-only');
const projectDir = path.resolve(valueAfter('--project') || process.env.CODEX_PROJECT_DIR || process.cwd());

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const configPath = path.join(codexHome, 'config.toml');
const projectCodexDir = path.join(projectDir, '.codex');
const projectConfigPath = path.join(projectCodexDir, 'config.toml');
const serverPath = path.resolve(__dirname, 'mcp-server', 'dist', 'codex-mcp-shim.js');
const sessionStartHookPath = path.resolve(__dirname, 'hosts', 'codex', 'hooks', 'session-start.js');
const userPromptHookPath = path.resolve(__dirname, 'hosts', 'codex', 'hooks', 'user-prompt-submit.js');
const permissionHookPath = path.resolve(__dirname, 'hosts', 'codex', 'hooks', 'permission-request.js');
if (!fs.existsSync(serverPath)) {
  console.error(`error: bundled MCP server not found at ${serverPath}`);
  console.error('hint:  cd hosts && npm install && npm run build');
  process.exit(1);
}
for (const hookPath of [sessionStartHookPath, userPromptHookPath, permissionHookPath]) {
  if (!fs.existsSync(hookPath)) {
    console.error(`error: Codex hook not found at ${hookPath}`);
    process.exit(1);
  }
}

const desiredBlock = formatBlock({
  command: 'node',
  args: [serverPath],
});

function formatBlock({ command, args }) {
  const argsToml = args.map((a) => JSON.stringify(a)).join(', ');
  return [
    '[mcp_servers.telegram]',
    `command = ${JSON.stringify(command)}`,
    `args = [${argsToml}]`,
    formatTomlEnvVars(),
  ].join('\n');
}

function hooksBlock(managedFilter) {
  return [
    '# BEGIN agents-comm-bus codex hooks',
    ...(managedFilter ? [managedFilter, ''] : []),
    '[[hooks.SessionStart]]',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(`node ${sessionStartHookPath}`)}`,
    '',
    '[[hooks.UserPromptSubmit]]',
    '',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(`node ${userPromptHookPath}`)}`,
    '',
    '[[hooks.PermissionRequest]]',
    'matcher = "*"',
    '',
    '[[hooks.PermissionRequest.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(`node ${permissionHookPath}`)}`,
    '# END agents-comm-bus codex hooks',
  ].join('\n');
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function ensureCodexHome() {
  if (!fs.existsSync(codexHome)) {
    if (DRY_RUN) {
      console.log(`would create ${codexHome}`);
    } else {
      fs.mkdirSync(codexHome, { recursive: true });
    }
  }
}

function readConfig() {
  if (!fs.existsSync(configPath)) return '';
  return fs.readFileSync(configPath, 'utf-8');
}

function readFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function appendBlock(content, block) {
  const trimmed = content.replace(/\s*$/, '');
  if (trimmed === '') return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

function writeConfig(newContent) {
  if (DRY_RUN) {
    console.log('--- would write ---');
    console.log(newContent);
    console.log('--- end ---');
    return;
  }
  fs.writeFileSync(configPath, newContent, 'utf-8');
}

function writeFileEnsured(filePath, newContent) {
  if (DRY_RUN) {
    console.log(`--- would write ${filePath} ---`);
    console.log(newContent);
    console.log('--- end ---');
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, newContent, 'utf-8');
}

function installMcp() {
  ensureCodexHome();
  const existing = readConfig();
  const lines = existing.split(/\r?\n/);
  const range = findTableRange(lines, 'mcp_servers.telegram');

  if (range === null) {
    writeConfig(appendBlock(existing, desiredBlock));
    console.log(`installed [mcp_servers.telegram] in ${configPath}`);
    console.log(`  args[0] = ${serverPath}`);
    return true;
  }

  const currentBlock = lines.slice(range.start, range.end).join('\n');
  if (currentBlock.trim() === desiredBlock.trim()) {
    console.log(`[mcp_servers.telegram] in ${configPath} is already up to date.`);
    return false;
  }

  console.log('existing block:');
  console.log(indent(currentBlock));
  console.log('desired block:');
  console.log(indent(desiredBlock));

  if (!FORCE) {
    console.error('refusing to overwrite without --force.');
    console.error('re-run with `node install-codex.js --force` to replace.');
    process.exit(1);
  }

  writeConfig(spliceLines(lines, range, desiredBlock).join('\n'));
  console.log(`replaced [mcp_servers.telegram] in ${configPath}`);
  console.log(`  args[0] = ${serverPath}`);
  return true;
}

function prepareProjectHooks() {
  const existing = readFileIfExists(projectConfigPath);
  const withoutOldBlock = removeMarkedBlock(existing);
  const filter = prepareShellEnvFilter(withoutOldBlock);
  const withFeatures = ensureHooksFeature(filter.content);
  const withHooks = appendBlock(withFeatures, hooksBlock(filter.managedFilter));
  const synced = syncProjectMcpEnvVars(withHooks);
  const next = synced.content;
  if (hasProjectMcpDeclaration(existing)) {
    try {
      assertCanonicalProjectEnvVars(next);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot install Codex hooks without canonical MCP env_vars: ${detail} ` +
        `Use a [mcp_servers.telegram] table instead of an inline declaration.`,
      );
    }
  }
  return { existing, next, synced };
}

function installProjectHooks({ existing, next, synced }) {
  if (normalizeConfig(existing) === normalizeConfig(next)) {
    console.log(`Codex hooks in ${projectConfigPath} are already up to date.`);
    return false;
  }
  writeFileEnsured(projectConfigPath, next);
  console.log(`installed Codex hooks in ${projectConfigPath}`);
  if (synced.changed) {
    console.log(`  synced canonical env_vars on existing [mcp_servers.telegram] override`);
  }
  console.log(`  SessionStart = ${sessionStartHookPath}`);
  console.log(`  UserPromptSubmit = ${userPromptHookPath}`);
  console.log(`  PermissionRequest = ${permissionHookPath}`);
  return true;
}

function removeMarkedBlock(content) {
  const begin = '# BEGIN agents-comm-bus codex hooks';
  const end = '# END agents-comm-bus codex hooks';
  const start = content.indexOf(begin);
  if (start === -1) return content;
  const finish = content.indexOf(end, start);
  if (finish === -1) return content;
  return `${content.slice(0, start)}${content.slice(finish + end.length)}`.replace(/\n{3,}/g, '\n\n');
}

function ensureHooksFeature(content) {
  const lines = content.split(/\r?\n/);
  const range = findTableRange(lines, 'features');
  if (range === null) {
    return appendBlock(content, ['[features]', 'hooks = true'].join('\n'));
  }
  const featureLines = lines.slice(range.start, range.end);
  const hookLine = featureLines.findIndex((line) => /^\s*hooks\s*=/.test(line));
  if (hookLine === -1) {
    featureLines.push('hooks = true');
  } else {
    featureLines[hookLine] = 'hooks = true';
  }
  return spliceLines(lines, range, featureLines.join('\n')).join('\n');
}

function normalizeConfig(content) {
  return content.replace(/\s+$/g, '').replace(/\r\n/g, '\n');
}

function main() {
  // Validate the project policy before even the existing global MCP write.
  const hooks = MCP_ONLY ? undefined : prepareProjectHooks();
  if (!HOOKS_ONLY) installMcp();
  if (hooks) installProjectHooks(hooks);
}

function indent(text) {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

main();
