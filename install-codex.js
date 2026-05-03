#!/usr/bin/env node
// install-codex.js — wires the Telegram MCP server into Codex's config.toml.
//
// Codex doesn't (yet) auto-register MCP servers from a plugin manifest, and
// has no path-substitution macro like Claude Code's ${CLAUDE_PLUGIN_ROOT}.
// So we resolve the absolute path to the bundled MCP server here and write
// it directly into ~/.codex/config.toml under [mcp_servers.telegram].
//
// Usage:
//   node install-codex.js          # install or update (interactive prompt if existing entry differs)
//   node install-codex.js --force  # overwrite existing entry without prompting
//   node install-codex.js --dry-run  # print what would change, write nothing
//
// Re-run any time the repo path changes.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const configPath = path.join(codexHome, 'config.toml');

const serverPath = path.resolve(__dirname, 'mcp-server', 'dist', 'server.js');
if (!fs.existsSync(serverPath)) {
  console.error(`error: bundled MCP server not found at ${serverPath}`);
  console.error(`hint:  cd mcp-server && npm install && npm run build`);
  process.exit(1);
}

const desiredBlock = formatBlock({
  command: 'node',
  args: [serverPath, '--agent=codex', '--app-server-url=ws://127.0.0.1:4500'],
});

function formatBlock({ command, args }) {
  const argsToml = args.map((a) => JSON.stringify(a)).join(', ');
  return [
    '[mcp_servers.telegram]',
    `command = ${JSON.stringify(command)}`,
    `args = [${argsToml}]`,
  ].join('\n');
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

// Find the line range [start, end) of the [mcp_servers.telegram] table.
// Returns null if absent. The end is the index of the next top-level table
// header (line starting with [) or the end of the file.
function findTableRange(lines, header) {
  const headerRe = new RegExp(`^\\s*\\[${header.replace(/\./g, '\\.')}\\]\\s*$`);
  const anyHeaderRe = /^\s*\[[^\]]+\]\s*$/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyHeaderRe.test(lines[i])) { end = i; break; }
  }
  // Trim trailing blank lines from the block so we don't strip user spacing.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { start, end };
}

function spliceLines(lines, range, replacement) {
  const before = lines.slice(0, range.start);
  const after = lines.slice(range.end);
  return [...before, ...replacement.split('\n'), ...after];
}

function appendBlock(content, block) {
  const trimmed = content.replace(/\s*$/, '');
  if (trimmed === '') return block + '\n';
  return trimmed + '\n\n' + block + '\n';
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

function main() {
  ensureCodexHome();
  const existing = readConfig();
  const lines = existing.split(/\r?\n/);
  const range = findTableRange(lines, 'mcp_servers.telegram');

  if (range === null) {
    // Append.
    const next = appendBlock(existing, desiredBlock);
    writeConfig(next);
    console.log(`installed [mcp_servers.telegram] in ${configPath}`);
    console.log(`  args[0] = ${serverPath}`);
    return;
  }

  const currentBlock = lines.slice(range.start, range.end).join('\n');
  if (currentBlock.trim() === desiredBlock.trim()) {
    console.log(`[mcp_servers.telegram] in ${configPath} is already up to date.`);
    return;
  }

  // Different — show the diff.
  console.log('existing block:');
  console.log(indent(currentBlock));
  console.log('desired block:');
  console.log(indent(desiredBlock));

  if (!FORCE) {
    console.error('refusing to overwrite without --force.');
    console.error('re-run with `node install-codex.js --force` to replace.');
    process.exit(1);
  }

  const next = spliceLines(lines, range, desiredBlock).join('\n');
  writeConfig(next);
  console.log(`replaced [mcp_servers.telegram] in ${configPath}`);
  console.log(`  args[0] = ${serverPath}`);
}

function indent(s) {
  return s.split('\n').map((l) => '    ' + l).join('\n');
}

main();
