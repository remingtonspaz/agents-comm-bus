import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeWakeDirForProject } from '../../../agents-comm-bus/dist/core-daemon/bridges/claude/wake.js';
import { normalizeProjectPath } from '../../../agents-comm-bus/dist/core-daemon/project-path.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveProjectPath() {
  return normalizeProjectPath(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd());
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

// Walk the full process ancestry from `startPid` in ONE PowerShell invocation
// using an in-process Get-CimInstance loop. This replaces a previous per-pid
// `wmic.exe` loop (one exe spawn per process, up to 15 per walk) that
// intermittently failed under session-restart churn: a single transient wmic
// hiccup truncated the walk and yielded ClaudePid=0, so the watcher fuzzy-matched
// the wrong window and never self-exited (zombie). Stress testing measured ~56%
// failures even with a resolvable cmd.exe -> claude.exe tree present. One PS
// process (CIM is in-process, no per-pid exe spawn) is far more robust under
// contention; a single retry covers a transient PS-spawn failure. EncodedCommand
// avoids all nested-quote escaping.
function readProcessChainViaCim(startPid, log = () => {}) {
  const psScript =
    `$ProgressPreference='SilentlyContinue';` +
    `$cur=${Number.parseInt(startPid, 10)};` +
    `for($i=0;$i -lt 15;$i++){` +
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue;` +
    `if(-not $p){break};` +
    `Write-Output ("{0}:{1}" -f $p.ProcessId,$p.Name);` +
    `if(-not $p.ParentProcessId -or $p.ParentProcessId -le 0){break};` +
    `$cur=$p.ParentProcessId}`;
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
        { encoding: 'utf-8', windowsHide: true, timeout: 8000 },
      );
      const chain = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf(':');
          if (idx < 0) return null;
          const pid = Number.parseInt(line.slice(0, idx), 10);
          const name = line.slice(idx + 1).trim().toLowerCase();
          return Number.isFinite(pid) ? { pid, name: name || null } : null;
        })
        .filter(Boolean);
      if (chain.length > 0) return chain;
    } catch (error) {
      log(`readProcessChainViaCim attempt ${attempt + 1} failed: ${error.message}`);
    }
  }
  return [];
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
    const chain = readProcessChainViaCim(process.pid, log);

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

export function enterWatcherScriptCandidates(fromDir = __dirname) {
  return [
    // Staged plugin MCP shim: plugins/claude/<comm>/scripts/
    path.resolve(fromDir, 'scripts', 'enter-watcher.ps1'),
    // Staged hook bundle: <plugin>/hooks/ → ../scripts/
    path.resolve(fromDir, '..', 'scripts', 'enter-watcher.ps1'),
    // MCP shim dev bundle (mcp-server/dist) or hosts/claude source → <repo>/scripts/
    path.resolve(fromDir, '..', '..', 'scripts', 'enter-watcher.ps1'),
    // Source hook tree: hosts/claude/hooks/ → ../../../scripts/
    path.resolve(fromDir, '..', '..', '..', 'scripts', 'enter-watcher.ps1'),
  ];
}

export function resolveEnterWatcherScript(fromDir = __dirname) {
  return enterWatcherScriptCandidates(fromDir).find((candidate) => fs.existsSync(candidate)) ?? null;
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

  const watcherScript = resolveEnterWatcherScript(__dirname);
  if (!watcherScript) {
    log('ERROR: Watcher script not found (enter-watcher.ps1) in any known layout');
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
