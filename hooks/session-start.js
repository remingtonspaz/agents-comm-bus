#!/usr/bin/env node
/**
 * SessionStart Hook - Auto-spawns the Claude wake watcher
 *
 * This hook runs when Claude Code starts a session. It spawns the PowerShell
 * watcher script that monitors the Claude wake path and sends keystrokes to
 * the Claude window. The watcher is not a Telegram/comm-state owner; daemon
 * code decides when a normal turn wake or query wake suppression should happen.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log to stderr (stdout may be used for hook response)
function log(message) {
  console.error(`[claude-session-start] ${message}`);
}

function hashProjectKey(projectPath) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectPath.length; i++) {
    hash ^= projectPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function resolveProjectPath() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

function resolveClaudeWakeDir() {
  const projectPath = path.resolve(resolveProjectPath());
  const basename = path.basename(projectPath) || 'project';
  return path.join(
    os.homedir(),
    '.agents-comm-bus',
    'claude-wake',
    'sessions',
    `${basename}-${hashProjectKey(projectPath)}`
  );
}

// Find the Claude Code window PID by walking up process tree
function findClaudeWindowPid() {
  if (os.platform() !== 'win32') {
    log('Auto-watcher only supported on Windows');
    return null;
  }

  try {
    let currentPid = process.pid;

    // Walk up the process tree looking for cmd.exe
    for (let i = 0; i < 10; i++) {
      const result = execSync(
        `wmic process where ProcessId=${currentPid} get ParentProcessId /format:value`,
        { encoding: 'utf-8', windowsHide: true }
      );

      const match = result.match(/ParentProcessId=(\d+)/);
      if (!match) break;

      const parentPid = parseInt(match[1], 10);
      if (parentPid <= 0) break;

      // Check if parent is cmd.exe
      try {
        const nameResult = execSync(
          `wmic process where ProcessId=${parentPid} get Name /format:value`,
          { encoding: 'utf-8', windowsHide: true }
        );

        if (nameResult.includes('cmd.exe')) {
          log(`Found Claude window: cmd.exe (PID: ${parentPid})`);
          return parentPid;
        }
      } catch (e) {
        // Process might not exist anymore
      }

      currentPid = parentPid;
    }

    log('Could not find cmd.exe ancestor');
    return null;
  } catch (e) {
    log(`Error finding Claude window PID: ${e.message}`);
    return null;
  }
}

// Spawn the Claude wake watcher script with target PID
function spawnEnterWatcher(targetPid) {
  const watcherScript = path.join(__dirname, '..', 'scripts', 'enter-watcher.ps1');
  const wakeDir = resolveClaudeWakeDir();

  log(`Watcher script path: ${watcherScript}`);
  if (!fs.existsSync(watcherScript)) {
    log(`ERROR: Watcher script not found: ${watcherScript}`);
    return;
  }

  const args = [
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', watcherScript
  ];

  args.push('-SessionDir', wakeDir);

  if (targetPid) {
    args.push('-TargetPid', targetPid.toString());
  }

  log(`Spawning: powershell ${args.join(' ')}`);

  try {
    const watcher = spawn('powershell', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    watcher.on('error', (err) => {
      log(`Watcher spawn error: ${err.message}`);
    });

    watcher.unref();
    log(`Spawned Claude wake watcher (PID: ${watcher.pid}, mode: ${targetPid || 'search'}, wakeDir: ${wakeDir})`);
  } catch (err) {
    log(`ERROR spawning watcher: ${err.message}`);
  }
}

// Track initialization state to prevent double-initialization
let initialized = false;

function safeInitializeWatcher() {
  if (initialized) return;
  initialized = true;
  initializeWatcher();
}

// Main
async function main() {
  // Read hook input from stdin (if any)
  let input = '';
  process.stdin.setEncoding('utf8');

  // Non-blocking read with timeout
  const timeout = setTimeout(() => {
    // No input received, proceed anyway
    safeInitializeWatcher();
  }, 100);

  process.stdin.on('data', (chunk) => {
    input += chunk;
  });

  process.stdin.on('end', () => {
    clearTimeout(timeout);
    safeInitializeWatcher();
  });

  // If stdin is not a TTY and has no data, proceed immediately
  if (process.stdin.isTTY === false) {
    clearTimeout(timeout);
    safeInitializeWatcher();
  }
}

function initializeWatcher() {
  log('Initializing Claude wake watcher...');
  const claudePid = findClaudeWindowPid();
  spawnEnterWatcher(claudePid);

  // Output empty response (hook completed successfully)
  console.log(JSON.stringify({}));
}

main().catch((err) => {
  log(`Error in session-start hook: ${err.message}`);
  console.log(JSON.stringify({}));
});
