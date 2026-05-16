#!/usr/bin/env node
/**
 * SessionStart Hook - Auto-spawns the Claude wake watcher.
 *
 * The watcher is only a Claude keystroke bridge. The daemon decides when a
 * wake is appropriate and writes trigger-enter into the registered wake dir.
 */

import { ensureClaudeWakeWatcher } from './claude/wake-support.js';

function log(message) {
  console.error(`[claude-session-start] ${message}`);
}

let initialized = false;

function safeInitializeWatcher() {
  if (initialized) return;
  initialized = true;
  ensureClaudeWakeWatcher({ log });
  console.log(JSON.stringify({}));
}

async function main() {
  process.stdin.setEncoding('utf8');

  const timeout = setTimeout(() => {
    safeInitializeWatcher();
  }, 100);

  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    safeInitializeWatcher();
  });

  if (process.stdin.isTTY === false) {
    clearTimeout(timeout);
    safeInitializeWatcher();
  }
}

main().catch((error) => {
  log(`Error in session-start hook: ${error.message}`);
  console.log(JSON.stringify({}));
});
