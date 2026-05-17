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
const serverPath = path.resolve(__dirname, 'mcp-server', 'dist', 'server.js');
const userPromptHookPath = path.resolve(__dirname, 'hooks', 'codex', 'user-prompt-submit.js');
const permissionHookPath = path.resolve(__dirname, 'hooks', 'codex', 'permission-request.js');
if (!fs.existsSync(serverPath)) {
  console.error(`error: bundled MCP server not found at ${serverPath}`);
  console.error('hint:  cd mcp-server && npm install && npm run build');
  process.exit(1);
}
for (const hookPath of [userPromptHookPath, permissionHookPath]) {
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
  ].join('\n');
}

function hooksBlock() {
  return [
    '# BEGIN agents-comm-bus codex hooks',
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

function findTableRange(lines, header) {
  const headerRe = new RegExp(`^\\s*\\[${header.replace(/\./g, '\\.')}\\]\\s*$`);
  const anyHeaderRe = /^\s*\[[^\]]+\]\s*$/;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (anyHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { start, end };
}

function spliceLines(lines, range, replacement) {
  return [
    ...lines.slice(0, range.start),
    ...replacement.split('\n'),
    ...lines.slice(range.end),
  ];
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

function installProjectHooks() {
  const existing = readFileIfExists(projectConfigPath);
  const withoutOldBlock = removeMarkedBlock(existing);
  const withFeatures = ensureHooksFeature(withoutOldBlock);
  const next = appendBlock(withFeatures, hooksBlock());
  if (normalizeConfig(existing) === normalizeConfig(next)) {
    console.log(`Codex hooks in ${projectConfigPath} are already up to date.`);
    return false;
  }
  writeFileEnsured(projectConfigPath, next);
  console.log(`installed Codex hooks in ${projectConfigPath}`);
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
  if (!HOOKS_ONLY) installMcp();
  if (!MCP_ONLY) installProjectHooks();
}

function indent(text) {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

main();
