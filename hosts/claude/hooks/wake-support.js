import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeWakeDirForProject } from '../../../agents-comm-bus/dist/core-daemon/bridges/claude/wake.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveProjectPath() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd());
}

export function resolveClaudeWakeDir(projectPath = resolveProjectPath()) {
  return claudeWakeDirForProject(projectPath);
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

function wmicProcess(pid) {
  try {
    const result = execSync(
      `wmic process where ProcessId=${pid} get Name,ParentProcessId /format:value`,
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 },
    );
    const nameMatch = result.match(/Name=([^\r\n]+)/);
    const parentMatch = result.match(/ParentProcessId=(\d+)/);
    return {
      name: nameMatch ? nameMatch[1].trim() : null,
      parentPid: parentMatch ? Number.parseInt(parentMatch[1], 10) : null,
    };
  } catch {
    return { name: null, parentPid: null };
  }
}

function resolveMainWindowHandle(pid) {
  try {
    const result = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()"`,
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 },
    );
    const hwnd = Number.parseInt(result.trim(), 10);
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
  } catch {
    return null;
  }
}

export function findCmdAncestor(log = () => {}) {
  if (os.platform() !== 'win32') return null;

  try {
    const chain = [];
    let currentPid = process.pid;
    for (let i = 0; i < 15; i += 1) {
      const info = wmicProcess(currentPid);
      chain.push({ pid: currentPid, name: info.name?.toLowerCase() || null });
      if (!info.parentPid || info.parentPid <= 0) break;
      currentPid = info.parentPid;
    }

    log(`process chain: ${chain.map((c) => `${c.name || '?'}#${c.pid}`).join(' <- ')}`);

    for (let i = 1; i < chain.length; i += 1) {
      if (chain[i].name === 'cmd.exe' && chain[i - 1].name === 'claude.exe') {
        const cmdPid = chain[i].pid;
        const claudePid = chain[i - 1].pid;
        return {
          pid: cmdPid,
          hwnd: resolveMainWindowHandle(cmdPid),
          claudePid,
        };
      }
    }

    log('no persistent cmd.exe ancestor found (parent of claude.exe)');
    return null;
  } catch (error) {
    log(`findCmdAncestor error: ${error.message}`);
    return null;
  }
}

export function findClaudeWindowPid(log = () => {}) {
  return findCmdAncestor(log)?.pid ?? null;
}

function escapeForPwshSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function buildStartProcessCommand(watcherScript, watcherArgs) {
  const argList = [
    "'-ExecutionPolicy'",
    "'Bypass'",
    "'-WindowStyle'",
    "'Hidden'",
    "'-File'",
    `'${escapeForPwshSingleQuoted(watcherScript)}'`,
    ...watcherArgs.map((arg) => `'${escapeForPwshSingleQuoted(arg)}'`),
  ].join(', ');
  return (
    `Start-Process -FilePath 'powershell' -ArgumentList ${argList} ` +
    `-WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`
  );
}

function tryAcquireWatcherLock(wakeDir, log) {
  const lockFile = path.join(wakeDir, 'watcher.lock');
  try {
    fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx' });
    return lockFile;
  } catch {
    try {
      const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (ageMs < 30_000) {
        log('watcher spawn already in progress (lock <30s old); skipping');
        return null;
      }
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx' });
      return lockFile;
    } catch {
      log('could not acquire watcher spawn lock');
      return null;
    }
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
  if (!fs.existsSync(watcherScript)) {
    log(`ERROR: Watcher script not found: ${watcherScript}`);
    return { started: false, wakeDir, reason: 'missing_script' };
  }

  const lockFile = tryAcquireWatcherLock(wakeDir, log);
  if (!lockFile) {
    return { started: false, wakeDir, reason: 'lock_held' };
  }

  try {
    // Re-check after acquiring lock — another hook may have spawned a watcher
    // between our isPidAlive check and our lock acquisition.
    const racedPid = readWatcherPid(wakeDir);
    if (racedPid && racedPid !== existingPid && isPidAlive(racedPid)) {
      return { started: false, pid: racedPid, wakeDir, reason: 'raced_already_running' };
    }

    const cmdInfo = options.cmdInfo ?? findCmdAncestor(log);

    const watcherArgs = ['-SessionDir', wakeDir];
    if (cmdInfo?.hwnd) {
      watcherArgs.push('-WindowHandle', String(cmdInfo.hwnd));
    } else if (cmdInfo?.pid) {
      watcherArgs.push('-TargetPid', String(cmdInfo.pid));
    }
    if (cmdInfo?.claudePid) {
      watcherArgs.push('-ClaudePid', String(cmdInfo.claudePid));
    }

    const command = buildStartProcessCommand(watcherScript, watcherArgs);
    log(`Spawning watcher via Start-Process: ${command}`);
    const stdout = execSync(`powershell -NoProfile -Command "${command}"`, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10_000,
    });
    const watcherPid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(watcherPid) || watcherPid <= 0) {
      log(`Watcher spawn returned invalid pid: ${stdout.trim()}`);
      return { started: false, wakeDir, reason: 'invalid_pid' };
    }

    fs.writeFileSync(path.join(wakeDir, 'watcher.pid'), `${watcherPid}\n`, 'utf8');
    log(
      `Spawned Claude wake watcher (PID: ${watcherPid}, wakeDir: ${wakeDir}, ` +
        `target=${cmdInfo?.hwnd ? `hwnd:${cmdInfo.hwnd}` : cmdInfo?.pid ? `pid:${cmdInfo.pid}` : 'search'})`,
    );
    return { started: true, pid: watcherPid, wakeDir, cmdInfo };
  } catch (error) {
    log(`Watcher spawn error: ${error.message}`);
    try {
      fs.appendFileSync(
        path.join(wakeDir, 'debug.log'),
        `[${new Date().toISOString()}] wake-support spawn error: ${error.message}\n`,
      );
    } catch {}
    return { started: false, wakeDir, reason: 'spawn_error', error: error.message };
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}
