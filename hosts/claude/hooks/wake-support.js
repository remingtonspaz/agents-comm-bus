import { createHash } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeWakeDirForProject } from '../../../agents-comm-bus/dist/core-daemon/bridges/claude/wake.js';
import { normalizeProjectPath } from '../../../agents-comm-bus/dist/core-daemon/project-path.js';
import { accountLabelScopeFromEnvSafe } from '../../common/comm-labels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveProjectPath() {
  return normalizeProjectPath(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd());
}

export function resolveClaudeWakeDir(
  projectPath = resolveProjectPath(),
  env = process.env,
) {
  return claudeWakeDirForProject(
    projectPath,
    undefined,
    accountLabelScopeFromEnvSafe(env),
  );
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

// AGE-79: dedup off the CURRENT watcher's structured metadata, NEVER the
// append-only debug.log. The old AGE-70 belt grepped the entire debug.log for
// `ClaudePid=0`; a single stale line anywhere in that history (e.g. one
// pre-AGE-70 targetless watcher from months ago) made the check return true
// forever, so dedup NEVER short-circuited and every hook fire leaked a new
// watcher. `watcher.json` records the live watcher's identity so we can tell a
// real targeted watcher from a targetless zombie without touching history.
const WATCHER_META_FILE = 'watcher.json';

function readWatcherMeta(wakeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(wakeDir, WATCHER_META_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// AGE-79 (split-brain fix): watcher.json is the SINGLE AUTHORITATIVE record.
// Dedup reads the pid from it first, falling back to the legacy watcher.pid only
// for pre-fix/migration watchers (which have no watcher.json yet). This makes
// watcher.pid a best-effort mirror whose write failure cannot split-brain the
// dedup — once watcher.json commits, the new watcher is always discoverable.
function readAuthoritativeWatcherPid(wakeDir) {
  const meta = readWatcherMeta(wakeDir);
  if (meta && Number.isInteger(meta.pid) && meta.pid > 0) return meta.pid;
  return readWatcherPid(wakeDir);
}

// Best-effort legacy mirror of the authoritative pid; injectable for tests.
function defaultWriteWatcherPid(wakeDir, pid) {
  fs.writeFileSync(path.join(wakeDir, 'watcher.pid'), `${pid}\n`, 'utf8');
}

// AGE-79 (B3): watcher.json is load-bearing for dedup, so write it ATOMICALLY
// (temp + rename) and let failures THROW. A silently-missing record would make
// the new watcher permanently non-reusable and re-leak a watcher every hook.
function writeWatcherMeta(wakeDir, meta) {
  const finalPath = path.join(wakeDir, WATCHER_META_FILE);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(meta)}\n`, 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

// AGE-79 (B1): read a pid's command line so we can PROVE identity before we
// reuse or KILL it — guards against PID reuse (a stale watcher.pid whose number
// now belongs to an unrelated process). Injectable for tests.
function defaultReadProcessCommandLine(pid) {
  try {
    // execFileSync (direct powershell.exe spawn, no cmd.exe shell) so
    // windowsHide/CREATE_NO_WINDOW actually suppresses the console — execSync's
    // shell wrapper leaks a visible powershell window flash on every call.
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf-8', windowsHide: true, timeout: 5_000 },
    );
    return String(out).trim();
  } catch {
    return '';
  }
}

// AGE-79 (B1 hardening): parse the `-SessionDir` arg (quoted or bare) so identity
// uses an EXACT path match. `includes(wakeDir)` would let `…88c6be72-other`
// satisfy `…88c6be72` (prefix collision) and reuse/kill the wrong session.
function parseSessionDirArg(cmd) {
  const m = /-SessionDir\s+(?:"([^"]+)"|(\S+))/i.exec(cmd);
  return m ? (m[1] ?? m[2]) : null;
}

function samePath(a, b) {
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  } catch {
    return false;
  }
}

// Parse a numeric watcher arg (e.g. `-ClaudePid 5360`) from a command line.
function parseIntArg(cmd, name) {
  const m = new RegExp(`-${name}\\s+(\\d+)`, 'i').exec(cmd);
  return m ? Number.parseInt(m[1], 10) : null;
}

// AGE-79 (B1 fail-closed): inspect a live pid. `state` is fail-closed 3-way:
//   'ours'         — pid IS our enter-watcher.ps1 for THIS exact wake dir; the
//                    parsed claudePid/hwnd ride along so we can adopt metadata.
//   'foreign'      — a different/unrelated process (PID reuse).
//   'unverifiable' — command line couldn't be read (transient CIM failure); the
//                    caller MUST fail closed (don't spawn a dup, don't kill),
//                    because AGE-69 documents transient CIM failures under churn.
function inspectWatcher(pid, wakeDir, readProcessCommandLine) {
  if (!pid) return { state: 'foreign' };
  const cmd = readProcessCommandLine(pid);
  if (!cmd) return { state: 'unverifiable' };
  if (!/enter-watcher/i.test(cmd)) return { state: 'foreign' };
  const sessionDir = parseSessionDirArg(cmd);
  if (!sessionDir || !samePath(sessionDir, wakeDir)) return { state: 'foreign' };
  return { state: 'ours', claudePid: parseIntArg(cmd, 'ClaudePid') ?? 0, hwnd: parseIntArg(cmd, 'WindowHandle') };
}

// The structured record points at this pid with a real target (claudePid > 0).
function watcherMetaMatches(wakeDir, pid) {
  const meta = readWatcherMeta(wakeDir);
  return Boolean(meta && meta.pid === pid && Number.isInteger(meta.claudePid) && meta.claudePid > 0);
}

// If a live recorded pid should short-circuit the spawn, return the
// {started:false,...} result; else null (caller proceeds to spawn). Identity is
// evaluated FIRST for ANY alive recorded pid — NOT gated on metadata — so a
// pre-fix watcher (live watcher.pid, no watcher.json) that is temporarily
// unverifiable still fails CLOSED instead of spawning a migration duplicate.
function dedupeLiveWatcher(pid, wakeDir, alreadyRunningReason, deps) {
  const { pidAlive, readProcessCommandLine, writeMeta, log } = deps;
  if (!pid || !pidAlive(pid)) return null;
  const info = inspectWatcher(pid, wakeDir, readProcessCommandLine);
  if (info.state === 'unverifiable') {
    log(`watcher ${pid} identity temporarily unverifiable; not spawning, will retry next hook`);
    return { started: false, pid, wakeDir, reason: 'identity_unverifiable' };
  }
  if (info.state === 'foreign') return null; // recorded pid was reused; spawn.
  // 'ours': a targetless watcher (no live claude target) is a zombie — replace it.
  if (!(Number.isInteger(info.claudePid) && info.claudePid > 0)) return null;
  // Verified our watcher for this session, with a real target — reuse it. Adopt
  // metadata (best-effort) if missing/stale so the next hook can dedup without a
  // CIM lookup. Makes the AGE-79 migration seamless (no spawn, no kill).
  if (!watcherMetaMatches(wakeDir, pid)) {
    try {
      writeMeta(wakeDir, { pid, claudePid: info.claudePid, hwnd: info.hwnd ?? null });
      log(`Adopted existing watcher ${pid} into watcher.json`);
    } catch {
      // best-effort; reuse regardless — next hook re-verifies via CIM.
    }
  }
  return { started: false, pid, wakeDir, reason: alreadyRunningReason };
}

// Retire a superseded watcher — kill ONLY when identity is verified 'ours'. A
// 'foreign' pid is never killed (PID reuse); an 'unverifiable' pid is left alone
// (fail closed — the next hook retires it once identity is readable).
function retireWatcher(pid, wakeDir, killWatcher, readProcessCommandLine, log) {
  if (!pid) return;
  const { state } = inspectWatcher(pid, wakeDir, readProcessCommandLine);
  if (state !== 'ours') {
    log(`Not retiring PID ${pid}: identity=${state} (fail-closed; only 'ours' is killed)`);
    return;
  }
  try {
    killWatcher(pid);
    log(`Retired superseded watcher PID ${pid}`);
  } catch {
    // best-effort
  }
}

function hasPreciseWatcherSelector(cmdInfo) {
  return Boolean(cmdInfo?.hwnd || cmdInfo?.pid);
}

const PROCESS_CHAIN_MAX_DEPTH = 30;

// Parse `ProcessId:ParentProcessId:Name` lines from a one-shot Win32_Process snapshot.
export function parseProcessSnapshotLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(':');
      if (parts.length < 3) return null;
      const pid = Number.parseInt(parts[0], 10);
      const parentPid = Number.parseInt(parts[1], 10);
      const name = parts.slice(2).join(':').trim().toLowerCase();
      if (!Number.isFinite(pid)) return null;
      return {
        pid,
        parentPid: Number.isFinite(parentPid) ? parentPid : 0,
        name: name || null,
      };
    })
    .filter(Boolean);
}

// Walk from `startPid` upward using a parsed snapshot table (self-first, max depth 30).
export function buildProcessChainFromSnapshot(snapshotLines, startPid, options = {}) {
  const maxDepth = options.maxDepth ?? PROCESS_CHAIN_MAX_DEPTH;
  const byPid = new Map();
  for (const row of snapshotLines) {
    byPid.set(row.pid, row);
  }

  const chain = [];
  const seen = new Set();
  let cur = Number.parseInt(startPid, 10);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isFinite(cur) || cur <= 0) break;
    if (seen.has(cur)) break;
    seen.add(cur);
    const row = byPid.get(cur);
    if (!row) break;
    chain.push({ pid: cur, name: row.name });
    if (!row.parentPid || row.parentPid <= 0) break;
    cur = row.parentPid;
  }
  return chain;
}

// Walk ancestry from `startPid` in ONE PowerShell invocation: a single
// Get-CimInstance snapshot of all processes, then walk ParentProcessId in JS.
// This replaces a previous per-pid CIM loop (up to 15 sequential queries per walk)
// that cost ~16s under herdr when no cmd.exe ancestor exists. One PS process
// (AGE-79: in-process CIM, no per-pid exe spawn) remains the robustness fix; the
// snapshot avoids repeating that cost on every ancestor step. EncodedCommand avoids
// nested-quote escaping; one retry covers a transient PS-spawn failure.
function readProcessChainViaCim(startPid, log = () => {}) {
  const psScript =
    `$ProgressPreference='SilentlyContinue';` +
    `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name |` +
    `ForEach-Object { Write-Output ("{0}:{1}:{2}" -f $_.ProcessId,$_.ParentProcessId,$_.Name) }`;
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { encoding: 'utf-8', windowsHide: true, timeout: 8000 },
      );
      const snapshot = parseProcessSnapshotLines(result);
      const chain = buildProcessChainFromSnapshot(snapshot, startPid);
      if (chain.length > 0) return chain;
    } catch (error) {
      log(`readProcessChainViaCim attempt ${attempt + 1} failed: ${error.message}`);
    }
  }
  return [];
}

function resolveMainWindowHandle(pid) {
  try {
    const result = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`],
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 },
    );
    const hwnd = Number.parseInt(result.trim(), 10);
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
  } catch {
    return null;
  }
}

function defaultSyncSleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function walkCmdClaudeChain(chain, log) {
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

  return null;
}

export function findCmdAncestor(log = () => {}, deps = {}) {
  // deps.platform: cross-platform test seam (defaults to os.platform()).
  const platform = deps.platform ?? os.platform();
  if (platform !== 'win32') return null;

  const env = deps.env ?? process.env;
  if (env.HERDR_ENV === '1') {
    log('herdr pane: no cmd.exe console; skipping cmd ancestor walk');
    return null;
  }

  const backoffMs = deps.backoffMs ?? [0, 500, 1000];
  const sleep = deps.sleep ?? defaultSyncSleep;
  const readChain =
    deps.readChain ??
    ((chainLog) => {
      const chain = readProcessChainViaCim(process.pid, chainLog);
      return walkCmdClaudeChain(chain, chainLog);
    });

  try {
    for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
      const delayMs = backoffMs[attempt];
      if (delayMs > 0) sleep(delayMs);

      const result = readChain(log);
      if (result) {
        log(`findCmdAncestor attempt ${attempt + 1}/${backoffMs.length}: resolved`);
        return result;
      }
      log(`findCmdAncestor attempt ${attempt + 1}/${backoffMs.length}: no cmd->claude match`);
    }

    log('no persistent cmd.exe ancestor found (parent of claude.exe)');
    return null;
  } catch (error) {
    log(`findCmdAncestor error: ${error.message}`);
    return null;
  }
}

function claudeExecutableName(name) {
  const lower = String(name || '').toLowerCase();
  return lower === 'claude.exe' || lower === 'claude';
}

function walkClaudePidFromChain(chain, log) {
  log(`process chain: ${chain.map((c) => `${c.name || '?'}#${c.pid}`).join(' <- ')}`);
  for (const entry of chain) {
    if (claudeExecutableName(entry.name)) return entry.pid;
  }
  return null;
}

const OWNER_PID_CACHE_TTL_MS = 5 * 60 * 1000;

function claudeOwnerCachePath(session) {
  const digest = createHash('sha256').update(String(session)).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), 'agents-comm-bus-claude-owner', `${digest}.json`);
}

/** Owner pid for session lease — cmd.exe path in native terminals, or claude.exe under herdr. */
export function findClaudeOwnerPid(log = () => {}, deps = {}) {
  const env = deps.env ?? process.env;
  const findCmd = deps.findCmdAncestor ?? findCmdAncestor;
  const isHerdr = env.HERDR_ENV === '1';

  if (!isHerdr) {
    const cmd = findCmd(log, deps);
    if (cmd?.claudePid) return cmd.claudePid;
  }

  const platform = deps.platform ?? os.platform();
  if (platform !== 'win32') return null;

  try {
    const chain = deps.readChainRaw
      ? deps.readChainRaw(log)
      : readProcessChainViaCim(process.pid, log);
    return walkClaudePidFromChain(chain, log);
  } catch (error) {
    log(`findClaudeOwnerPid error: ${error.message}`);
    return null;
  }
}

// Per-hook-session cache: avoids repeating the snapshot walk on every UserPromptSubmit /
// PermissionRequest in the same Claude session. TTL + pidAlive (process.kill(0); EPERM
// counts as alive) bound PID-reuse risk without a per-hit PowerShell creation-time check
// (~0.5–0.8s), which would defeat the cache.
export function resolveClaudeOwnerPidCached({ session, log = () => {}, deps = {} }) {
  const nowFn = deps.now ?? (() => Date.now());
  const pidAlive = deps.pidAlive ?? isPidAlive;
  const fsDeps = deps.fs ?? fs;
  const resolve = deps.resolve ?? ((chainLog, resolveDeps) => findClaudeOwnerPid(chainLog, resolveDeps));
  const cachePath = deps.cachePath ?? claudeOwnerCachePath(session);

  try {
    const raw = fsDeps.readFileSync(cachePath, 'utf8');
    const cached = JSON.parse(raw);
    const ageMs = nowFn() - cached.resolvedAt;
    if (
      Number.isInteger(cached.pid) &&
      cached.pid > 0 &&
      ageMs >= 0 &&
      ageMs < OWNER_PID_CACHE_TTL_MS &&
      pidAlive(cached.pid)
    ) {
      return cached.pid;
    }
  } catch {
    // miss, corrupt, or stale — re-resolve below
  }

  const pid = resolve(log, deps);
  if (pid) {
    try {
      fsDeps.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tmpPath = `${cachePath}.${process.pid}.${nowFn()}.tmp`;
      fsDeps.writeFileSync(tmpPath, `${JSON.stringify({ pid, resolvedAt: nowFn() })}\n`, 'utf8');
      fsDeps.renameSync(tmpPath, cachePath);
    } catch {
      // best-effort; still return pid
    }
  }
  return pid;
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
  const pidAlive = options.isPidAlive || isPidAlive;
  const killWatcher = options.killWatcher || ((pid) => process.kill(pid));
  const readProcessCommandLine = options.readProcessCommandLine || defaultReadProcessCommandLine;
  const writeMeta = options.writeWatcherMeta || writeWatcherMeta;
  const writeWatcherPid = options.writeWatcherPid || defaultWriteWatcherPid;
  if (os.platform() !== 'win32') {
    log('Auto-watcher only supported on Windows');
    return { started: false, reason: 'unsupported_platform' };
  }

  const projectPath = options.projectPath || resolveProjectPath();
  const wakeDir =
    options.wakeDir ||
    resolveClaudeWakeDir(projectPath, options.env || process.env);
  fs.mkdirSync(wakeDir, { recursive: true });

  const identityDeps = { pidAlive, readProcessCommandLine, writeMeta, log };
  const existingPid = readAuthoritativeWatcherPid(wakeDir);
  const existingDedupe = dedupeLiveWatcher(existingPid, wakeDir, 'already_running', identityDeps);
  if (existingDedupe) return existingDedupe;

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
    const racedPid = readAuthoritativeWatcherPid(wakeDir);
    if (racedPid !== existingPid) {
      const racedDedupe = dedupeLiveWatcher(racedPid, wakeDir, 'raced_already_running', identityDeps);
      if (racedDedupe) return racedDedupe;
    }

    const cmdInfo = options.cmdInfo !== undefined ? options.cmdInfo : findCmdAncestor(log);
    if (!hasPreciseWatcherSelector(cmdInfo)) {
      log(
        'no cmd ancestor resolved; skipping watcher spawn (relying on next-hook retry + AGE-69 backoff)',
      );
      return { started: false, reason: 'no_cmd_ancestor', wakeDir };
    }

    const watcherArgs = ['-SessionDir', wakeDir];
    if (cmdInfo.hwnd) {
      watcherArgs.push('-WindowHandle', String(cmdInfo.hwnd));
    } else if (cmdInfo.pid) {
      watcherArgs.push('-TargetPid', String(cmdInfo.pid));
    }
    if (cmdInfo.claudePid) {
      watcherArgs.push('-ClaudePid', String(cmdInfo.claudePid));
    }

    const command = buildStartProcessCommand(watcherScript, watcherArgs);
    log(`Spawning watcher via Start-Process: ${command}`);
    const spawnWatcher =
      options.spawnWatcher ??
      ((spawnCommand) => {
        const stdout = execFileSync('powershell', ['-NoProfile', '-Command', spawnCommand], {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 10_000,
        });
        return Number.parseInt(stdout.trim(), 10);
      });
    const watcherPid = spawnWatcher(command);
    if (!Number.isInteger(watcherPid) || watcherPid <= 0) {
      log(`Watcher spawn returned invalid pid: ${String(watcherPid)}`);
      return { started: false, wakeDir, reason: 'invalid_pid' };
    }

    // AGE-79: watcher.json is the SINGLE AUTHORITATIVE record — commit it
    // atomically FIRST. watcher.pid is only a best-effort legacy mirror, so the
    // mirror write (below) failing can't split-brain: dedup reads the
    // authoritative pid from watcher.json.
    try {
      writeMeta(wakeDir, {
        pid: watcherPid,
        claudePid: cmdInfo.claudePid ?? 0,
        hwnd: cmdInfo.hwnd ?? null,
      });
    } catch (metaError) {
      // The just-spawned watcherPid is OWNED — kill it directly. If it
      // terminates, the prior authoritative record is untouched (nothing
      // untracked survives). If the kill FAILS, mirror the new pid to
      // watcher.pid so the live watcher stays discoverable (watcher.json wasn't
      // committed, so dedup falls back to the mirror).
      let terminated = false;
      try {
        killWatcher(watcherPid);
        terminated = true;
      } catch {
        terminated = false;
      }
      if (terminated) {
        log(
          `Watcher metadata write failed (${metaError.message}); killed owned new watcher ` +
            `${watcherPid}; prior record preserved`,
        );
      } else {
        // Kill failed → the new watcher is live and MUST stay discoverable.
        // Mirror its pid; then drop the now-stale prior watcher.json so the
        // authoritative reader (which prefers watcher.json) falls back to the
        // mirror instead of resurrecting the dead/foreign/targetless old pid.
        let mirrored = false;
        try {
          writeWatcherPid(wakeDir, watcherPid);
          mirrored = true;
        } catch {
          mirrored = false;
        }
        if (mirrored) {
          try {
            fs.rmSync(path.join(wakeDir, WATCHER_META_FILE), { force: true });
          } catch {
            // best-effort; keep the old JSON if we can't remove it.
          }
        }
        log(
          `Watcher metadata write failed (${metaError.message}) AND could not kill new watcher ` +
            `${watcherPid}; mirrored its pid${mirrored ? ' and dropped stale metadata' : ''} for discovery`,
        );
      }
      return { started: false, wakeDir, reason: 'meta_write_failed' };
    }
    // Authoritative record committed. Mirror to watcher.pid best-effort — a
    // failure here is non-fatal (dedup reads watcher.json first) and CANNOT
    // orphan the new watcher, so swallow it rather than let the outer catch turn
    // a committed spawn into spawn_error.
    try {
      writeWatcherPid(wakeDir, watcherPid);
    } catch (pidError) {
      log(`watcher.pid mirror write failed (${pidError.message}); watcher.json is authoritative for ${watcherPid}`);
    }
    // AGE-79: retire the watcher(s) we just replaced so duplicates can't pile up.
    // existingPid and racedPid are often the same watcher — dedup so we retire once.
    const retired = new Set();
    for (const priorPid of [existingPid, racedPid]) {
      if (priorPid && priorPid !== watcherPid && !retired.has(priorPid) && pidAlive(priorPid)) {
        retired.add(priorPid);
        retireWatcher(priorPid, wakeDir, killWatcher, readProcessCommandLine, log);
      }
    }
    log(
      `Spawned Claude wake watcher (PID: ${watcherPid}, wakeDir: ${wakeDir}, ` +
        `target=${cmdInfo.hwnd ? `hwnd:${cmdInfo.hwnd}` : `pid:${cmdInfo.pid}`})`,
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
