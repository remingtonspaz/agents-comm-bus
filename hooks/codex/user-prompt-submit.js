#!/usr/bin/env node
/**
 * Codex UserPromptSubmit Hook
 *
 * Drains pending Telegram messages from the session queue (filled by
 * the MCP server's bot listener) and injects them as additional context
 * before Codex sees the user's prompt.
 *
 * No watcher process to spawn — Codex's app-server JSON-RPC handles
 * "wake idle agent" on its own, replacing the keystroke-injection path
 * the Claude Code version needed.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

function getSessionDir(cwd) {
  const basename = path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, '_');
  const hash = crypto.createHash('md5').update(cwd).digest('hex').substring(0, 6);
  return path.join(os.homedir(), '.claude-telegram', `${basename}-${hash}`);
}

const SESSION_DIR = getSessionDir(process.cwd());
const QUEUE_FILE = path.join(SESSION_DIR, 'queue.json');

async function main() {
  // Drain stdin (Codex sends hook input as JSON; we don't need it).
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  if (!fs.existsSync(QUEUE_FILE)) {
    process.exit(0);
  }

  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    process.exit(0);
  }

  const messages = queue.messages || [];
  if (messages.length === 0) process.exit(0);

  const formatted = messages
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString();
      const content = m.imagePath
        ? `[Image: ${m.imagePath}]${m.text ? ' ' + m.text : ''}`
        : m.text;
      return `[${time}] ${m.from}: ${content}`;
    })
    .join('\n');

  const contextText = `[Telegram Messages Received]\n${formatted}\n[End Telegram Messages]`;

  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify({ messages: [] }, null, 2));
  } catch {}

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: contextText,
      },
    })
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`telegram-context hook error: ${err.message}`);
  process.exit(1);
});
