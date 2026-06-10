#!/usr/bin/env node
import { createRequire as __acbCreateRequire } from 'module'; const require = __acbCreateRequire(import.meta.url);

// ../hosts/claude/hooks/wake-support.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// dist/core-daemon/bridges/claude/wake.js
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

// dist/core-daemon/bridges/claude/wake.js
function hashProjectKey(projectPath) {
  let hash = 2166136261;
  for (let i = 0; i < projectPath.length; i += 1) {
    hash ^= projectPath.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function claudeWakeDirForProject(projectPath, homeDir = os.homedir()) {
  const canonical = normalizeProjectPath(projectPath);
  const basename = path2.basename(canonical) || "project";
  return path2.join(homeDir, ".agents-comm-bus", "claude-wake", "sessions", `${basename}-${hashProjectKey(canonical)}`);
}

// ../hosts/claude/hooks/wake-support.js
var __filename = fileURLToPath(import.meta.url);
var __dirname = path3.dirname(__filename);
function resolveProjectPath() {
  return normalizeProjectPath(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd());
}
function resolveClaudeWakeDir(projectPath = resolveProjectPath()) {
  return claudeWakeDirForProject(projectPath);
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
function wmicProcess(pid) {
  try {
    const result = execSync(
      `wmic process where ProcessId=${pid} get Name,ParentProcessId /format:value`,
      { encoding: "utf-8", windowsHide: true, timeout: 5e3 }
    );
    const nameMatch = result.match(/Name=([^\r\n]+)/);
    const parentMatch = result.match(/ParentProcessId=(\d+)/);
    return {
      name: nameMatch ? nameMatch[1].trim() : null,
      parentPid: parentMatch ? Number.parseInt(parentMatch[1], 10) : null
    };
  } catch {
    return { name: null, parentPid: null };
  }
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
function findCmdAncestor(log2 = () => {
}) {
  if (os2.platform() !== "win32") return null;
  try {
    const chain = [];
    let currentPid = process.pid;
    for (let i = 0; i < 15; i += 1) {
      const info = wmicProcess(currentPid);
      chain.push({ pid: currentPid, name: info.name?.toLowerCase() || null });
      if (!info.parentPid || info.parentPid <= 0) break;
      currentPid = info.parentPid;
    }
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
  if (os2.platform() !== "win32") {
    log2("Auto-watcher only supported on Windows");
    return { started: false, reason: "unsupported_platform" };
  }
  const projectPath = options.projectPath || resolveProjectPath();
  const wakeDir = options.wakeDir || resolveClaudeWakeDir(projectPath);
  fs.mkdirSync(wakeDir, { recursive: true });
  const existingPid = readWatcherPid(wakeDir);
  if (existingPid && isPidAlive(existingPid)) {
    return { started: false, pid: existingPid, wakeDir, reason: "already_running" };
  }
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
    const racedPid = readWatcherPid(wakeDir);
    if (racedPid && racedPid !== existingPid && isPidAlive(racedPid)) {
      return { started: false, pid: racedPid, wakeDir, reason: "raced_already_running" };
    }
    const cmdInfo = options.cmdInfo ?? findCmdAncestor(log2);
    const watcherArgs = ["-SessionDir", wakeDir];
    if (cmdInfo?.hwnd) {
      watcherArgs.push("-WindowHandle", String(cmdInfo.hwnd));
    } else if (cmdInfo?.pid) {
      watcherArgs.push("-TargetPid", String(cmdInfo.pid));
    }
    if (cmdInfo?.claudePid) {
      watcherArgs.push("-ClaudePid", String(cmdInfo.claudePid));
    }
    const command = buildStartProcessCommand(watcherScript, watcherArgs);
    log2(`Spawning watcher via Start-Process: ${command}`);
    const stdout = execSync(`powershell -NoProfile -Command "${command}"`, {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 1e4
    });
    const watcherPid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(watcherPid) || watcherPid <= 0) {
      log2(`Watcher spawn returned invalid pid: ${stdout.trim()}`);
      return { started: false, wakeDir, reason: "invalid_pid" };
    }
    fs.writeFileSync(path3.join(wakeDir, "watcher.pid"), `${watcherPid}
`, "utf8");
    log2(
      `Spawned Claude wake watcher (PID: ${watcherPid}, wakeDir: ${wakeDir}, target=${cmdInfo?.hwnd ? `hwnd:${cmdInfo.hwnd}` : cmdInfo?.pid ? `pid:${cmdInfo.pid}` : "search"})`
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
