import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeWakeDirForProject } from '../../agents-comm-bus/dist/adapters/agent/claude-wake.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveProjectPath() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd());
}

export function resolveClaudeWakeDir(projectPath = resolveProjectPath()) {
  return claudeWakeDirForProject(projectPath);
}

export function findClaudeWindowPid(log = () => {}) {
  if (os.platform() !== 'win32') {
    log('Auto-watcher only supported on Windows');
    return null;
  }

  try {
    let currentPid = process.pid;
    for (let i = 0; i < 10; i += 1) {
      const result = execSync(
        `wmic process where ProcessId=${currentPid} get ParentProcessId /format:value`,
        { encoding: 'utf-8', windowsHide: true },
      );
      const match = result.match(/ParentProcessId=(\d+)/);
      if (!match) break;

      const parentPid = Number.parseInt(match[1], 10);
      if (parentPid <= 0) break;

      try {
        const nameResult = execSync(
          `wmic process where ProcessId=${parentPid} get Name /format:value`,
          { encoding: 'utf-8', windowsHide: true },
        );
        if (nameResult.includes('cmd.exe')) {
          log(`Found Claude window: cmd.exe (PID: ${parentPid})`);
          return parentPid;
        }
      } catch {
        // Parent may have exited while walking the process tree.
      }

      currentPid = parentPid;
    }
    log('Could not find cmd.exe ancestor');
    return null;
  } catch (error) {
    log(`Error finding Claude window PID: ${error.message}`);
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readWatcherPid(wakeDir) {
  try {
    const raw = fs.readFileSync(path.join(wakeDir, 'watcher.pid'), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function ensureClaudeWakeWatcher(options = {}) {
  const log = options.log || (() => {});
  if (os.platform() !== 'win32') {
    log('Auto-watcher only supported on Windows');
    return { started: false, reason: 'unsupported_platform' };
  }

  const projectPath = options.projectPath || resolveProjectPath();
  const wakeDir = options.wakeDir || resolveClaudeWakeDir(projectPath);
  fs.mkdirSync(wakeDir, { recursive: true });

  const existingPid = readWatcherPid(wakeDir);
  if (existingPid && isPidAlive(existingPid)) {
    return { started: false, pid: existingPid, wakeDir, reason: 'already_running' };
  }

  const watcherScript = path.resolve(__dirname, '..', '..', 'scripts', 'enter-watcher.ps1');
  log(`Watcher script path: ${watcherScript}`);
  if (!fs.existsSync(watcherScript)) {
    log(`ERROR: Watcher script not found: ${watcherScript}`);
    return { started: false, wakeDir, reason: 'missing_script' };
  }

  const targetPid = options.targetPid ?? findClaudeWindowPid(log);
  const args = [
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', watcherScript,
    '-SessionDir', wakeDir,
  ];
  if (targetPid) args.push('-TargetPid', String(targetPid));

  log(`Spawning: powershell ${args.join(' ')}`);
  const watcher = spawn('powershell', args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  watcher.on('error', (error) => {
    log(`Watcher spawn error: ${error.message}`);
  });
  watcher.unref();
  fs.writeFileSync(path.join(wakeDir, 'watcher.pid'), `${watcher.pid}\n`, 'utf8');
  log(`Spawned Claude wake watcher (PID: ${watcher.pid}, mode: ${targetPid || 'search'}, wakeDir: ${wakeDir})`);
  return { started: true, pid: watcher.pid, wakeDir };
}
