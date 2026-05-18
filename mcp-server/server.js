#!/usr/bin/env node
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ensureDaemon } from "../agents-comm-bus/dist/bootstrap/ensure-daemon.js";
import { connectIpc } from "../agents-comm-bus/dist/ipc/client.js";
import { PersistentIpcClient } from "../agents-comm-bus/dist/ipc/persistent-client.js";
import { DAEMON_VERSION } from "../agents-comm-bus/dist/config.js";

function log(message) {
  console.error(`[telegram-mcp] ${message}`);
}

let persistentRegistration = null;
const codexRuntime = {
  appServerUrl: null,
  threadId: null,
};

function agentInUse() {
  if (process.env.AGENTS_COMM_BUS_AGENT) return process.env.AGENTS_COMM_BUS_AGENT;
  if (
    process.env.CODEX_APP_SERVER_URL ||
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_PLUGIN_ROOT ||
    codexRuntime.appServerUrl
  ) {
    return "codex";
  }
  return "claude";
}

function sessionInUse() {
  if (process.env.AGENTS_COMM_BUS_SESSION_ID) return process.env.AGENTS_COMM_BUS_SESSION_ID;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  if (
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_APP_SERVER_URL ||
    codexRuntime.threadId ||
    codexRuntime.appServerUrl
  ) {
    const raw = process.env.CODEX_SESSION_ID ??
      process.env.CODEX_THREAD_ID ??
      codexRuntime.threadId ??
      `${process.cwd()}:${process.env.CODEX_APP_SERVER_URL ?? codexRuntime.appServerUrl ?? ""}`;
    return `codex_${crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 24)}`;
  }
  return "mcp";
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
        params: { clientInfo: { name: "telegram-mcp-server", version: "2.0.0" } },
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

async function daemonRequest(method, params = {}) {
  await discoverCodexRuntime();
  const agent = agentInUse();
  const ensured = await ensureDaemon({
    clientVersion: DAEMON_VERSION,
    metadata: {
      shimName: "telegram-mcp-server",
      agent,
      project: process.cwd(),
    },
    spawnDaemon: spawnDaemonFromMcpShim,
  });
  const connection = await connectIpc({
    port: ensured.port,
    clientVersion: DAEMON_VERSION,
    metadata: {
      shimName: "telegram-mcp-server",
      agent,
      project: process.cwd(),
    },
  });
  try {
    return await connection.request(method, {
      session: sessionInUse(),
      ...params,
    });
  } finally {
    connection.close();
  }
}

async function startPersistentCodexRegistration() {
  await discoverCodexRuntime();
  if (agentInUse() !== "codex") return;
  const appServerUrl = process.env.CODEX_APP_SERVER_URL ?? codexRuntime.appServerUrl;
  if (!appServerUrl) {
    log("Codex session registration skipped: CODEX_APP_SERVER_URL is not set");
    return;
  }
  if (persistentRegistration) return;

  const session = sessionInUse();
  const metadata = {
    shimName: "telegram-mcp-server/session-registration",
    agent: "codex",
    project: process.cwd(),
    session,
  };
  const registerParams = {
    agent: "codex",
    session,
    project: process.cwd(),
    cwd: process.cwd(),
    app_server_url: appServerUrl,
    source: "mcp-server",
    replace_existing_lease: true,
    manage_app_server_lifecycle: true,
  };

  const client = new PersistentIpcClient({
    clientVersion: DAEMON_VERSION,
    metadata,
    spawnDaemon: spawnDaemonFromMcpShim,
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

function spawnDaemonFromMcpShim(paths) {
  const daemonEntry = resolveDaemonEntry();
  const child = spawn(process.execPath, [daemonEntry, "serve"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENTS_COMM_BUS_STATE_ROOT: paths.root,
    },
  });
  child.unref();
}

function resolveDaemonEntry() {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    // Bundled runtime: mcp-server/dist/server.js -> repo root.
    new URL("../../agents-comm-bus/dist/serve.js", import.meta.url),
    // Source runtime: mcp-server/server.js -> repo root.
    new URL("../agents-comm-bus/dist/serve.js", import.meta.url),
  ].map((url) => fileURLToPath(url));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`agents-comm-bus daemon entry not found from ${here}; checked ${candidates.join(", ")}`);
  }
  return found;
}

function closePersistentRegistration() {
  if (!persistentRegistration) return;
  persistentRegistration.close();
  persistentRegistration = null;
}

const server = new Server(
  { name: "telegram-mcp-server", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "telegram_send",
      description: "Send a text message via the agents-comm-bus Telegram daemon. Supply chat_id to target explicitly; omitted target uses the session's most recent inbound conversation or returns an error.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message text to send" },
          chat_id: { type: ["string", "number"], description: "Optional Telegram chat id" },
          message_thread_id: { type: ["string", "number"], description: "Optional Telegram forum/topic thread id" },
        },
        required: ["message"],
      },
    },
    {
      name: "telegram_send_image",
      description: "Send an image or file via the agents-comm-bus Telegram daemon.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the image/file" },
          caption: { type: "string", description: "Optional caption" },
          chat_id: { type: ["string", "number"], description: "Optional Telegram chat id" },
          message_thread_id: { type: ["string", "number"], description: "Optional Telegram forum/topic thread id" },
        },
        required: ["path"],
      },
    },
    {
      name: "telegram_check_messages",
      description: "Drain pending inbound Telegram messages from the agents-comm-bus daemon.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "list_conversations",
      description: "List conversation inventory from the agents-comm-bus daemon.",
      inputSchema: {
        type: "object",
        properties: {
          comm: { type: "string", description: "Optional comm filter, for example telegram" },
          limit: { type: "number", description: "Maximum conversations to return" },
        },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "telegram_send") {
      if (!args.message) return toolError("Error: message is required");
      const result = await daemonRequest("telegram_send", args);
      return toolText(`Message sent via agents-comm-bus (${result.message_id})`);
    }

    if (name === "telegram_send_image") {
      if (!args.path) return toolError("Error: path is required");
      if (!existsSync(args.path)) return toolError(`Error: File not found: ${args.path}`);
      const result = await daemonRequest("telegram_send_image", args);
      return toolText(`Image sent via agents-comm-bus (${result.message_id})`);
    }

    if (name === "telegram_check_messages") {
      const messages = await daemonRequest("telegram_check_messages", args);
      if (!messages.length) return toolText("No pending messages from Telegram");
      return toolText(formatMessages(messages));
    }

    if (name === "list_conversations") {
      const conversations = await daemonRequest("list_conversations", args);
      if (!conversations.length) return toolText("No conversations found");
      return toolText(formatConversations(conversations));
    }

    return toolError(`Unknown tool: ${name}`);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
});

function toolText(text) {
  return { content: [{ type: "text", text }] };
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function formatMessages(items) {
  return `${items.length} message(s) from Telegram:\n\n${items.map((item) => {
    const message = item.message;
    const time = new Date(message.received_at).toLocaleTimeString();
    const from = message.sender?.display_name ?? message.sender?.id ?? "User";
    const attachments = message.attachments?.length ? ` [${message.attachments.length} attachment(s)]` : "";
    return `[${time}] ${from}: ${message.text ?? ""}${attachments}`;
  }).join("\n")}`;
}

function formatConversations(conversations) {
  return conversations.map((conversation) => {
    const thread = conversation.thread_native_id ? `:${conversation.thread_native_id}` : "";
    const last = conversation.last_inbound_at ?? conversation.last_outbound_at;
    const lastText = last ? new Date(last).toISOString() : "no activity";
    return `${conversation.comm}/${conversation.account_label} ${conversation.chat_native_id}${thread} agent=${conversation.agent} last=${lastText}`;
  }).join("\n");
}

async function main() {
  await startPersistentCodexRegistration();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP shim connected via stdio");
}

process.once("exit", closePersistentRegistration);
process.once("SIGINT", () => {
  closePersistentRegistration();
  process.exit(130);
});
process.once("SIGTERM", () => {
  closePersistentRegistration();
  process.exit(143);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
