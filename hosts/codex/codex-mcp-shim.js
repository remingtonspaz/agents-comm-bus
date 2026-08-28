#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";

import {
  DAEMON_VERSION,
  PersistentIpcClient,
  ensureMcpRuntime,
  installShutdownHandlers,
  log,
  runMcpShim,
} from "../common/mcp-shim-shared.js";
import { normalizeProjectPath } from "../../agents-comm-bus/dist/core-daemon/project-path.js";
import { accountLabelScopeFromEnvSafe } from "../common/comm-labels.js";

let persistentRegistration = null;
const codexRuntime = {
  appServerUrl: null,
  threadId: null,
};

function agentInUse() {
  return process.env.AGENTS_COMM_BUS_AGENT ?? "codex";
}

function sessionInUse() {
  if (process.env.AGENTS_COMM_BUS_SESSION_ID) return process.env.AGENTS_COMM_BUS_SESSION_ID;
  const raw = process.env.CODEX_SESSION_ID ??
    process.env.CODEX_THREAD_ID ??
    codexRuntime.threadId ??
    `${process.cwd()}:${process.env.CODEX_APP_SERVER_URL ?? codexRuntime.appServerUrl ?? ""}`;
  return `codex_${crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 24)}`;
}

async function discoverCodexRuntime() {
  codexRuntime.appServerUrl ??= process.env.CODEX_APP_SERVER_URL ?? discoverAppServerUrlFromAncestors();
  codexRuntime.threadId ??= process.env.CODEX_SESSION_ID ?? process.env.CODEX_THREAD_ID ?? null;
  if (codexRuntime.appServerUrl && !codexRuntime.threadId) {
    codexRuntime.threadId = await discoverMostRecentThreadId(codexRuntime.appServerUrl);
  }
}

function discoverAppServerUrlFromAncestors() {
  if (process.platform !== "win32") return null;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid; i += 1) {
    const info = getWindowsProcessInfo(pid);
    if (!info) return null;
    const match = String(info.CommandLine ?? "").match(/\bapp-server\b[\s\S]*?--listen\s+("?)([^\s"]+)\1/i);
    if (match?.[2]) return match[2];
    pid = Number(info.ParentProcessId);
  }
  return null;
}

function getWindowsProcessInfo(pid) {
  try {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"`,
      "if ($null -eq $p) { exit 0 }",
      "$p | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
    ].join("; ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true,
    }).trim();
    return output ? JSON.parse(output) : null;
  } catch {
    return null;
  }
}

function discoverCodexOwnerProcess(appServerUrl) {
  const explicit = positiveInteger(process.env.AGENTS_COMM_BUS_OWNER_PID);
  if (explicit) {
    return { pid: explicit, label: process.env.AGENTS_COMM_BUS_OWNER_LABEL ?? "codex" };
  }

  const remoteOwner = discoverCodexRemoteOwnerProcess(appServerUrl);
  if (remoteOwner) return remoteOwner;

  return { pid: process.ppid, label: "codex-parent" };
}

function discoverCodexRemoteOwnerProcess(appServerUrl) {
  if (!appServerUrl) return null;
  if (process.platform === "win32") {
    try {
      const remote = powerShellSingleQuoted(appServerUrl);
      const script = [
        `$remote = ${remote}`,
        "$p = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
        "  $_.CommandLine -and",
        "  $_.CommandLine.Contains($remote) -and",
        "  $_.CommandLine -match '(?i)\\bresume\\b' -and",
        "  $_.CommandLine -notmatch '(?i)\\bapp-server\\b'",
        "} | Sort-Object @{ Expression = { if ($_.Name -ieq 'codex.exe') { 0 } else { 1 } } }, ProcessId | Select-Object -First 1 ProcessId,Name",
        "if ($null -ne $p) { $p | ConvertTo-Json -Compress }",
      ].join("\n");
      const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
      }).trim();
      if (!output) return null;
      const info = JSON.parse(output);
      const pid = positiveInteger(info.ProcessId);
      return pid ? { pid, label: "codex-remote-client" } : null;
    } catch {
      return null;
    }
  }

  try {
    const output = execFileSync("ps", ["-eo", "pid=,comm=,args="], {
      encoding: "utf8",
      timeout: 1500,
    });
    const lines = output.split(/\r?\n/).filter((line) =>
      line.includes(appServerUrl) &&
      /\bresume\b/i.test(line) &&
      !/\bapp-server\b/i.test(line)
    );
    if (lines.length === 0) return null;
    const codexLine = lines.find((line) => /\bcodex\b/i.test(line)) ?? lines[0];
    const pid = positiveInteger(codexLine.trim().split(/\s+/, 1)[0]);
    return pid ? { pid, label: "codex-remote-client" } : null;
  } catch {
    return null;
  }
}

function positiveInteger(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function powerShellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function discoverMostRecentThreadId(appServerUrl) {
  try {
    const result = await callCodexAppServer(appServerUrl, "thread/loaded/list", {}, { timeoutMs: 2500 });
    const threads = loadedThreads(result);
    if (threads.length === 0) return null;
    const target = [...threads].sort(compareThreadRecency)[0];
    return threadIdFrom(target);
  } catch {
    return null;
  }
}

function callCodexAppServer(url, method, params, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const initId = 1;
    const callId = 2;
    let settled = false;
    let initialized = false;
    const timer = setTimeout(() => finish(new Error(`Codex app-server timeout: ${method}`)), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: { clientInfo: { name: "agents-comm-mcp-shim", version: "2.0.0" } },
      }));
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.id === initId) {
        if (message.error) return finish(new Error(message.error.message ?? "Codex app-server initialize failed"));
        initialized = true;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }));
        return;
      }
      if (message.id === callId) {
        if (message.error) finish(new Error(message.error.message ?? "Codex app-server call failed"));
        else finish(null, message.result);
      }
    });
    ws.on("error", (error) => finish(error));
    ws.on("close", () => {
      if (!settled) {
        finish(new Error(initialized
          ? "Codex app-server closed before reply"
          : "Codex app-server closed before initialize"));
      }
    });
  });
}

function loadedThreads(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const candidate = result.data ?? result.threads ?? result.items ?? result.loaded;
  return Array.isArray(candidate) ? candidate : [];
}

function compareThreadRecency(a, b) {
  if (typeof a === "string" || typeof b === "string") return 0;
  const left = Date.parse(String(a?.lastActiveAt ?? a?.updatedAt ?? a?.startedAt ?? 0)) || 0;
  const right = Date.parse(String(b?.lastActiveAt ?? b?.updatedAt ?? b?.startedAt ?? 0)) || 0;
  return right - left;
}

function threadIdFrom(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const id = value.threadId ?? value.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function startPersistentCodexRegistration() {
  await discoverCodexRuntime();
  const appServerUrl = process.env.CODEX_APP_SERVER_URL ?? codexRuntime.appServerUrl;
  if (!appServerUrl) {
    log("Codex session registration skipped: CODEX_APP_SERVER_URL is not set");
    return;
  }
  if (persistentRegistration) return;

  const session = sessionInUse();
  const project = normalizeProjectPath(process.cwd());
  const metadata = {
    shimName: "agents-comm-mcp-shim/session-registration",
    agent: "codex",
    project,
    session,
  };
  const ownerProcess = discoverCodexOwnerProcess(appServerUrl);
  const threadId =
    process.env.CODEX_SESSION_ID ??
    process.env.CODEX_THREAD_ID ??
    codexRuntime.threadId ??
    null;
  const registerParams = {
    agent: "codex",
    session,
    project,
    cwd: project,
    app_server_url: appServerUrl,
    thread_id: threadId ?? undefined,
    owner_process_pid: ownerProcess.pid,
    owner_process_label: ownerProcess.label,
    source: "mcp-server",
    replace_existing_lease: true,
    persist_after_disconnect: true,
    manage_app_server_lifecycle: true,
    account_label_scope: accountLabelScopeFromEnvSafe(),
  };

  const runtime = await ensureMcpRuntime({
    agentInUse: () => "codex",
    shimName: "agents-comm-mcp-shim/session-registration",
  });

  const client = new PersistentIpcClient({
    clientVersion: DAEMON_VERSION,
    metadata,
    ensureDaemonOptions: {
      stateRoot: runtime.stateRoot,
      discoveryRoot: runtime.discoveryRoot,
      env: runtime.env,
    },
    log: (msg) => log(`ipc: ${msg}`),
    onDisconnected: (reason) => log(`ipc disconnected: ${reason}`),
    onReconnected: () => log("ipc reconnected; replaying Codex registration"),
    onError: (error) => log(`ipc error: ${error.message}`),
  });

  try {
    await client.start();
    const registered = await client.registerReplay("codex_register_session", registerParams);
    if (!registered?.ok) {
      client.close();
      log(`Codex session registration skipped: ${registered?.reason ?? "unknown failure"}`);
      return;
    }
    persistentRegistration = client;
    log(`Codex session registered: session=${session} app_server_url=${appServerUrl}`);
  } catch (error) {
    client.close();
    log(`Codex session registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function closePersistentRegistration() {
  if (!persistentRegistration) return;
  persistentRegistration.close();
  persistentRegistration = null;
}

installShutdownHandlers(closePersistentRegistration);

runMcpShim({
  agentInUse,
  sessionInUse,
  beforeDaemonRequest: discoverCodexRuntime,
  beforeConnect: startPersistentCodexRegistration,
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
