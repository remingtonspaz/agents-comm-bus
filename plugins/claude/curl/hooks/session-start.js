#!/usr/bin/env node
import { createRequire as __acbCreateRequire } from 'module'; const require = __acbCreateRequire(import.meta.url);

// ../hosts/claude/hooks/wake-support.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// dist/core-daemon/bridges/claude/wake.js
import crypto from "node:crypto";
import os from "node:os";
import path2 from "node:path";

// dist/core-daemon/project-path.js
import path from "node:path";
function normalizeProjectPath(project) {
  let resolved = path.resolve(project);
  if (path.sep === "\\") {
    resolved = resolved.replace(/\//g, "\\");
  } else {
    resolved = resolved.replace(/\\/g, "/");
  }
  if (/^[A-Za-z]:/.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1);
  }
  const isBareRoot = resolved === path.sep || path.sep === "\\" && /^[A-Za-z]:\\$/.test(resolved);
  if (resolved.length > 1 && resolved.endsWith(path.sep) && !isBareRoot) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

// dist/core-daemon/session-label-scope.js
function serializeAccountLabelScope(scope) {
  if (!scope || Object.keys(scope).length === 0)
    return null;
  const sorted = Object.keys(scope).sort();
  const canonical = {};
  for (const comm of sorted) {
    canonical[comm] = scope[comm];
  }
  return JSON.stringify(canonical);
}
function parseAccountLabelScope(stored) {
  if (stored === void 0 || stored === null)
    return null;
  const trimmed = stored.trim();
  if (trimmed.length === 0)
    return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`account_label_scope is not valid JSON: ${stored}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`account_label_scope must be a JSON object: ${stored}`);
  }
  const map = {};
  for (const [comm, label] of Object.entries(parsed)) {
    if (typeof label !== "string" || label.length === 0) {
      throw new Error(`account_label_scope value for "${comm}" must be a non-empty string`);
    }
    map[comm] = label;
  }
  return map;
}

// dist/core-daemon/runtime/session-owner-liveness.js
var DEFAULT_SESSION_OWNER_RECENCY_MS = 24 * 60 * 60 * 1e3;

// dist/core-daemon/bridges/claude/wake.js
function hashProjectKey(projectPath) {
  let hash = 2166136261;
  for (let i = 0; i < projectPath.length; i += 1) {
    hash ^= projectPath.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function claudeWakeDirForProject(projectPath, homeDir = os.homedir(), accountLabelScope = null) {
  const canonical = normalizeProjectPath(projectPath);
  const basename = path2.basename(canonical) || "project";
  const legacyDir = `${basename}-${hashProjectKey(canonical)}`;
  let canonicalScope;
  try {
    canonicalScope = serializeAccountLabelScope(parseAccountLabelScope(accountLabelScope));
  } catch (error) {
    console.error(`agents-comm-bus: invalid persisted Claude account_label_scope; using a scope-inert wake directory: ${error instanceof Error ? error.message : String(error)}`);
    canonicalScope = `__invalid__:${accountLabelScope}`;
  }
  return path2.join(homeDir, ".agents-comm-bus", "claude-wake", "sessions", canonicalScope ? `${legacyDir}-${crypto.createHash("sha256").update(canonicalScope).digest("hex").slice(0, 12)}` : legacyDir);
}

// ../hosts/common/comm-labels.js
function parseAgentsCommLabels(raw) {
  if (raw === void 0 || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const map = {};
  for (const entry of trimmed.split(",")) {
    const piece = entry.trim();
    if (piece.length === 0) {
      throw new Error(`AGENTS_COMM_LABELS contains an empty entry in "${raw}"`);
    }
    const colon = piece.indexOf(":");
    if (colon <= 0 || colon === piece.length - 1) {
      throw new Error(`AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`);
    }
    const comm = piece.slice(0, colon).trim();
    const label = piece.slice(colon + 1).trim();
    if (comm.length === 0 || label.length === 0) {
      throw new Error(`AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`);
    }
    if (map[comm] !== void 0) {
      throw new Error(`AGENTS_COMM_LABELS lists comm "${comm}" more than once`);
    }
    map[comm] = label;
  }
  return map;
}
function serializeAccountLabelScope2(scope) {
  if (!scope || Object.keys(scope).length === 0) return null;
  const sorted = Object.keys(scope).sort();
  const canonical = {};
  for (const comm of sorted) {
    canonical[comm] = scope[comm];
  }
  return JSON.stringify(canonical);
}
function accountLabelScopeFromEnv(env = process.env) {
  return serializeAccountLabelScope2(parseAgentsCommLabels(env.AGENTS_COMM_LABELS));
}
function accountLabelScopeFromEnvSafe(env = process.env, log2 = (message) => console.error(message)) {
  try {
    return accountLabelScopeFromEnv(env);
  } catch (error) {
    const raw = env.AGENTS_COMM_LABELS;
    log2(
      `ERROR: malformed AGENTS_COMM_LABELS=${JSON.stringify(raw)}: ${error instanceof Error ? error.message : String(error)}. This session is scope-inert: it will not consume any comm registration until AGENTS_COMM_LABELS is corrected and the session is restarted.`
    );
    return '{"__agents_comm_invalid__":"invalid"}';
  }
}

// ../hosts/claude/hooks/wake-support.js
var __filename = fileURLToPath(import.meta.url);
var __dirname = path3.dirname(__filename);
function resolveProjectPath() {
  return normalizeProjectPath(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd());
}
function resolveClaudeWakeDir(projectPath = resolveProjectPath(), env = process.env) {
  return claudeWakeDirForProject(
    projectPath,
    void 0,
    accountLabelScopeFromEnvSafe(env)
  );
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function readWatcherPid(wakeDir) {
  try {
    const raw = fs.readFileSync(path3.join(wakeDir, "watcher.pid"), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}
var WATCHER_META_FILE = "watcher.json";
function readWatcherMeta(wakeDir) {
  try {
    return JSON.parse(fs.readFileSync(path3.join(wakeDir, WATCHER_META_FILE), "utf8"));
  } catch {
    return null;
  }
}
function readAuthoritativeWatcherPid(wakeDir) {
  const meta = readWatcherMeta(wakeDir);
  if (meta && Number.isInteger(meta.pid) && meta.pid > 0) return meta.pid;
  return readWatcherPid(wakeDir);
}
function defaultWriteWatcherPid(wakeDir, pid) {
  fs.writeFileSync(path3.join(wakeDir, "watcher.pid"), `${pid}
`, "utf8");
}
function writeWatcherMeta(wakeDir, meta) {
  const finalPath = path3.join(wakeDir, WATCHER_META_FILE);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(meta)}
`, "utf8");
  fs.renameSync(tmpPath, finalPath);
}
function defaultReadProcessCommandLine(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { encoding: "utf-8", windowsHide: true, timeout: 5e3 }
    );
    return String(out).trim();
  } catch {
    return "";
  }
}
function parseSessionDirArg(cmd) {
  const m = /-SessionDir\s+(?:"([^"]+)"|(\S+))/i.exec(cmd);
  return m ? m[1] ?? m[2] : null;
}
function samePath(a, b) {
  try {
    return path3.resolve(a).toLowerCase() === path3.resolve(b).toLowerCase();
  } catch {
    return false;
  }
}
function parseIntArg(cmd, name) {
  const m = new RegExp(`-${name}\\s+(\\d+)`, "i").exec(cmd);
  return m ? Number.parseInt(m[1], 10) : null;
}
function inspectWatcher(pid, wakeDir, readProcessCommandLine) {
  if (!pid) return { state: "foreign" };
  const cmd = readProcessCommandLine(pid);
  if (!cmd) return { state: "unverifiable" };
  if (!/enter-watcher/i.test(cmd)) return { state: "foreign" };
  const sessionDir = parseSessionDirArg(cmd);
  if (!sessionDir || !samePath(sessionDir, wakeDir)) return { state: "foreign" };
  return { state: "ours", claudePid: parseIntArg(cmd, "ClaudePid") ?? 0, hwnd: parseIntArg(cmd, "WindowHandle") };
}
function watcherMetaMatches(wakeDir, pid) {
  const meta = readWatcherMeta(wakeDir);
  return Boolean(meta && meta.pid === pid && Number.isInteger(meta.claudePid) && meta.claudePid > 0);
}
function dedupeLiveWatcher(pid, wakeDir, alreadyRunningReason, deps) {
  const { pidAlive, readProcessCommandLine, writeMeta, log: log2 } = deps;
  if (!pid || !pidAlive(pid)) return null;
  const info = inspectWatcher(pid, wakeDir, readProcessCommandLine);
  if (info.state === "unverifiable") {
    log2(`watcher ${pid} identity temporarily unverifiable; not spawning, will retry next hook`);
    return { started: false, pid, wakeDir, reason: "identity_unverifiable" };
  }
  if (info.state === "foreign") return null;
  if (!(Number.isInteger(info.claudePid) && info.claudePid > 0)) return null;
  if (!watcherMetaMatches(wakeDir, pid)) {
    try {
      writeMeta(wakeDir, { pid, claudePid: info.claudePid, hwnd: info.hwnd ?? null });
      log2(`Adopted existing watcher ${pid} into watcher.json`);
    } catch {
    }
  }
  return { started: false, pid, wakeDir, reason: alreadyRunningReason };
}
function retireWatcher(pid, wakeDir, killWatcher, readProcessCommandLine, log2) {
  if (!pid) return;
  const { state } = inspectWatcher(pid, wakeDir, readProcessCommandLine);
  if (state !== "ours") {
    log2(`Not retiring PID ${pid}: identity=${state} (fail-closed; only 'ours' is killed)`);
    return;
  }
  try {
    killWatcher(pid);
    log2(`Retired superseded watcher PID ${pid}`);
  } catch {
  }
}
function hasPreciseWatcherSelector(cmdInfo) {
  return Boolean(cmdInfo?.hwnd || cmdInfo?.pid);
}
function readProcessChainViaCim(startPid, log2 = () => {
}) {
  const psScript = `$ProgressPreference='SilentlyContinue';$cur=${Number.parseInt(startPid, 10)};for($i=0;$i -lt 15;$i++){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue;if(-not $p){break};Write-Output ("{0}:{1}" -f $p.ProcessId,$p.Name);if(-not $p.ParentProcessId -or $p.ParentProcessId -le 0){break};$cur=$p.ParentProcessId}`;
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
        { encoding: "utf-8", windowsHide: true, timeout: 8e3 }
      );
      const chain = result.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const idx = line.indexOf(":");
        if (idx < 0) return null;
        const pid = Number.parseInt(line.slice(0, idx), 10);
        const name = line.slice(idx + 1).trim().toLowerCase();
        return Number.isFinite(pid) ? { pid, name: name || null } : null;
      }).filter(Boolean);
      if (chain.length > 0) return chain;
    } catch (error) {
      log2(`readProcessChainViaCim attempt ${attempt + 1} failed: ${error.message}`);
    }
  }
  return [];
}
function resolveMainWindowHandle(pid) {
  try {
    const result = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()"`,
      { encoding: "utf-8", windowsHide: true, timeout: 5e3 }
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
function walkCmdClaudeChain(chain, log2) {
  log2(`process chain: ${chain.map((c) => `${c.name || "?"}#${c.pid}`).join(" <- ")}`);
  for (let i = 1; i < chain.length; i += 1) {
    if (chain[i].name === "cmd.exe" && chain[i - 1].name === "claude.exe") {
      const cmdPid = chain[i].pid;
      const claudePid = chain[i - 1].pid;
      return {
        pid: cmdPid,
        hwnd: resolveMainWindowHandle(cmdPid),
        claudePid
      };
    }
  }
  return null;
}
function findCmdAncestor(log2 = () => {
}, deps = {}) {
  const platform = deps.platform ?? os2.platform();
  if (platform !== "win32") return null;
  const backoffMs = deps.backoffMs ?? [0, 500, 1e3];
  const sleep = deps.sleep ?? defaultSyncSleep;
  const readChain = deps.readChain ?? ((chainLog) => {
    const chain = readProcessChainViaCim(process.pid, chainLog);
    return walkCmdClaudeChain(chain, chainLog);
  });
  try {
    for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
      const delayMs = backoffMs[attempt];
      if (delayMs > 0) sleep(delayMs);
      const result = readChain(log2);
      if (result) {
        log2(`findCmdAncestor attempt ${attempt + 1}/${backoffMs.length}: resolved`);
        return result;
      }
      log2(`findCmdAncestor attempt ${attempt + 1}/${backoffMs.length}: no cmd->claude match`);
    }
    log2("no persistent cmd.exe ancestor found (parent of claude.exe)");
    return null;
  } catch (error) {
    log2(`findCmdAncestor error: ${error.message}`);
    return null;
  }
}
function enterWatcherScriptCandidates(fromDir = __dirname) {
  return [
    // Staged plugin MCP shim: plugins/claude/<comm>/scripts/
    path3.resolve(fromDir, "scripts", "enter-watcher.ps1"),
    // Staged hook bundle: <plugin>/hooks/ → ../scripts/
    path3.resolve(fromDir, "..", "scripts", "enter-watcher.ps1"),
    // MCP shim dev bundle (mcp-server/dist) or hosts/claude source → <repo>/scripts/
    path3.resolve(fromDir, "..", "..", "scripts", "enter-watcher.ps1"),
    // Source hook tree: hosts/claude/hooks/ → ../../../scripts/
    path3.resolve(fromDir, "..", "..", "..", "scripts", "enter-watcher.ps1")
  ];
}
function resolveEnterWatcherScript(fromDir = __dirname) {
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
    ...watcherArgs.map((arg) => `'${escapeForPwshSingleQuoted(arg)}'`)
  ].join(", ");
  return `Start-Process -FilePath 'powershell' -ArgumentList ${argList} -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`;
}
function tryAcquireWatcherLock(wakeDir, log2) {
  const lockFile = path3.join(wakeDir, "watcher.lock");
  try {
    fs.writeFileSync(lockFile, `${process.pid}
`, { flag: "wx" });
    return lockFile;
  } catch {
    try {
      const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (ageMs < 3e4) {
        log2("watcher spawn already in progress (lock <30s old); skipping");
        return null;
      }
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, `${process.pid}
`, { flag: "wx" });
      return lockFile;
    } catch {
      log2("could not acquire watcher spawn lock");
      return null;
    }
  }
}
function ensureClaudeWakeWatcher(options = {}) {
  const log2 = options.log || (() => {
  });
  const pidAlive = options.isPidAlive || isPidAlive;
  const killWatcher = options.killWatcher || ((pid) => process.kill(pid));
  const readProcessCommandLine = options.readProcessCommandLine || defaultReadProcessCommandLine;
  const writeMeta = options.writeWatcherMeta || writeWatcherMeta;
  const writeWatcherPid = options.writeWatcherPid || defaultWriteWatcherPid;
  if (os2.platform() !== "win32") {
    log2("Auto-watcher only supported on Windows");
    return { started: false, reason: "unsupported_platform" };
  }
  const projectPath = options.projectPath || resolveProjectPath();
  const wakeDir = options.wakeDir || resolveClaudeWakeDir(projectPath, options.env || process.env);
  fs.mkdirSync(wakeDir, { recursive: true });
  const identityDeps = { pidAlive, readProcessCommandLine, writeMeta, log: log2 };
  const existingPid = readAuthoritativeWatcherPid(wakeDir);
  const existingDedupe = dedupeLiveWatcher(existingPid, wakeDir, "already_running", identityDeps);
  if (existingDedupe) return existingDedupe;
  const watcherScript = resolveEnterWatcherScript(__dirname);
  if (!watcherScript) {
    log2("ERROR: Watcher script not found (enter-watcher.ps1) in any known layout");
    return { started: false, wakeDir, reason: "missing_script" };
  }
  const lockFile = tryAcquireWatcherLock(wakeDir, log2);
  if (!lockFile) {
    return { started: false, wakeDir, reason: "lock_held" };
  }
  try {
    const racedPid = readAuthoritativeWatcherPid(wakeDir);
    if (racedPid !== existingPid) {
      const racedDedupe = dedupeLiveWatcher(racedPid, wakeDir, "raced_already_running", identityDeps);
      if (racedDedupe) return racedDedupe;
    }
    const cmdInfo = options.cmdInfo !== void 0 ? options.cmdInfo : findCmdAncestor(log2);
    if (!hasPreciseWatcherSelector(cmdInfo)) {
      log2(
        "no cmd ancestor resolved; skipping watcher spawn (relying on next-hook retry + AGE-69 backoff)"
      );
      return { started: false, reason: "no_cmd_ancestor", wakeDir };
    }
    const watcherArgs = ["-SessionDir", wakeDir];
    if (cmdInfo.hwnd) {
      watcherArgs.push("-WindowHandle", String(cmdInfo.hwnd));
    } else if (cmdInfo.pid) {
      watcherArgs.push("-TargetPid", String(cmdInfo.pid));
    }
    if (cmdInfo.claudePid) {
      watcherArgs.push("-ClaudePid", String(cmdInfo.claudePid));
    }
    const command = buildStartProcessCommand(watcherScript, watcherArgs);
    log2(`Spawning watcher via Start-Process: ${command}`);
    const spawnWatcher = options.spawnWatcher ?? ((spawnCommand) => {
      const stdout = execSync(`powershell -NoProfile -Command "${spawnCommand}"`, {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 1e4
      });
      return Number.parseInt(stdout.trim(), 10);
    });
    const watcherPid = spawnWatcher(command);
    if (!Number.isInteger(watcherPid) || watcherPid <= 0) {
      log2(`Watcher spawn returned invalid pid: ${String(watcherPid)}`);
      return { started: false, wakeDir, reason: "invalid_pid" };
    }
    try {
      writeMeta(wakeDir, {
        pid: watcherPid,
        claudePid: cmdInfo.claudePid ?? 0,
        hwnd: cmdInfo.hwnd ?? null
      });
    } catch (metaError) {
      let terminated = false;
      try {
        killWatcher(watcherPid);
        terminated = true;
      } catch {
        terminated = false;
      }
      if (terminated) {
        log2(
          `Watcher metadata write failed (${metaError.message}); killed owned new watcher ${watcherPid}; prior record preserved`
        );
      } else {
        let mirrored = false;
        try {
          writeWatcherPid(wakeDir, watcherPid);
          mirrored = true;
        } catch {
          mirrored = false;
        }
        if (mirrored) {
          try {
            fs.rmSync(path3.join(wakeDir, WATCHER_META_FILE), { force: true });
          } catch {
          }
        }
        log2(
          `Watcher metadata write failed (${metaError.message}) AND could not kill new watcher ${watcherPid}; mirrored its pid${mirrored ? " and dropped stale metadata" : ""} for discovery`
        );
      }
      return { started: false, wakeDir, reason: "meta_write_failed" };
    }
    try {
      writeWatcherPid(wakeDir, watcherPid);
    } catch (pidError) {
      log2(`watcher.pid mirror write failed (${pidError.message}); watcher.json is authoritative for ${watcherPid}`);
    }
    const retired = /* @__PURE__ */ new Set();
    for (const priorPid of [existingPid, racedPid]) {
      if (priorPid && priorPid !== watcherPid && !retired.has(priorPid) && pidAlive(priorPid)) {
        retired.add(priorPid);
        retireWatcher(priorPid, wakeDir, killWatcher, readProcessCommandLine, log2);
      }
    }
    log2(
      `Spawned Claude wake watcher (PID: ${watcherPid}, wakeDir: ${wakeDir}, target=${cmdInfo.hwnd ? `hwnd:${cmdInfo.hwnd}` : `pid:${cmdInfo.pid}`})`
    );
    return { started: true, pid: watcherPid, wakeDir, cmdInfo };
  } catch (error) {
    log2(`Watcher spawn error: ${error.message}`);
    try {
      fs.appendFileSync(
        path3.join(wakeDir, "debug.log"),
        `[${(/* @__PURE__ */ new Date()).toISOString()}] wake-support spawn error: ${error.message}
`
      );
    } catch {
    }
    return { started: false, wakeDir, reason: "spawn_error", error: error.message };
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
    }
  }
}

// ../hosts/claude/hooks/session-start.js
function log(message) {
  console.error(`[claude-session-start] ${message}`);
}
var initialized = false;
function safeInitializeWatcher() {
  if (initialized) return;
  initialized = true;
  ensureClaudeWakeWatcher({ log });
  console.log(JSON.stringify({}));
}
async function main() {
  process.stdin.setEncoding("utf8");
  const timeout = setTimeout(() => {
    safeInitializeWatcher();
  }, 100);
  process.stdin.on("data", () => {
  });
  process.stdin.on("end", () => {
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
