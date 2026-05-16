#!/usr/bin/env node
// install-codex.js - wires the shared Telegram MCP shim into Codex config.
//
// Codex does not consume the Claude plugin manifest. This installer writes an
// absolute mcp server path into ~/.codex/config.toml and sets Codex-specific
// environment metadata. Runtime Telegram ownership still lives in the shared
// agents-comm-bus daemon.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const configPath = path.join(codexHome, 'config.toml');
const appServerUrl = process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:4500';

const serverPath = path.resolve(__dirname, 'mcp-server', 'dist', 'server.js');
if (!fs.existsSync(serverPath)) {
  console.error(`error: bundled MCP server not found at ${serverPath}`);
  console.error('hint:  cd mcp-server && npm install && npm run build');
  process.exit(1);
}

const desiredBlock = formatBlock({
  command: 'node',
  args: [serverPath],
  env: {
    AGENTS_COMM_BUS_AGENT: 'codex',
    CODEX_APP_SERVER_URL: appServerUrl,
  },
});

function formatBlock({ command, args, env }) {
  const argsToml = args.map((a) => JSON.stringify(a)).join(', ');
  const envToml = Object.entries(env)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(', ');
  return [
    '[mcp_servers.telegram]',
    `command = ${JSON.stringify(command)}`,
    `args = [${argsToml}]`,
    `env = { ${envToml} }`,
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

function main() {
  ensureCodexHome();
  const existing = readConfig();
  const lines = existing.split(/\r?\n/);
  const range = findTableRange(lines, 'mcp_servers.telegram');

  if (range === null) {
    writeConfig(appendBlock(existing, desiredBlock));
    console.log(`installed [mcp_servers.telegram] in ${configPath}`);
    console.log(`  args[0] = ${serverPath}`);
    return;
  }

  const currentBlock = lines.slice(range.start, range.end).join('\n');
  if (currentBlock.trim() === desiredBlock.trim()) {
    console.log(`[mcp_servers.telegram] in ${configPath} is already up to date.`);
    return;
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
}

function indent(text) {
  return text.split('\n').map((line) => `    ${line}`).join('\n');
}

main();
