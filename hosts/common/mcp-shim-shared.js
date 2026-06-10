import { existsSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { entryEnsures, resolveEntryContext } from "./install/entry-ensures.js";
import { applyDevConfig } from "./install/dev-config-resolver.js";
import { connectIpc } from "../../agents-comm-bus/dist/core-daemon/ipc/client.js";
import { resolveStatePaths } from "../../agents-comm-bus/dist/core-daemon/paths.js";
import { PersistentIpcClient } from "../../agents-comm-bus/dist/core-daemon/ipc/persistent-client.js";
import { DAEMON_VERSION } from "../../agents-comm-bus/dist/core-daemon/config.js";

export { DAEMON_VERSION, PersistentIpcClient };

export function log(message) {
  console.error(`[acb-mcp] ${message}`);
}

export async function ensureMcpRuntime(options) {
  const agent = options.agentInUse();
  const metadata = {
    shimName: options.shimName ?? "agents-comm-mcp-shim",
    agent,
    project: process.cwd(),
  };
  const ensureDaemonOptions = {
    clientVersion: DAEMON_VERSION,
    metadata,
    ...(options.spawnDaemon ? { spawnDaemon: options.spawnDaemon } : {}),
  };
  const ensured = await entryEnsures({
    fromDir: options.fromDir ?? import.meta.dirname,
    agent,
    env: options.env ?? process.env,
    stateRoot: options.stateRoot,
    ensureDaemonOptions,
    readOnlyCentralInstall: true,
  });
  return {
    agent,
    metadata,
    ensured,
    stateRoot: ensured.stateRoot,
    discoveryRoot: ensured.discoveryRoot,
    env: ensured.env,
  };
}

export const DEFAULT_ENSURE_COMMS_SCOPE_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_MIN_MS = 5 * 60 * 1_000;
export const DEFAULT_HEARTBEAT_MAX_MS = 10 * 60 * 1_000;

export function resolveMcpShimProject(env = process.env) {
  return env.CLAUDE_PROJECT_DIR ?? env.PWD ?? process.cwd();
}

export async function runWithStartupEnsureTimeout(work, timeoutMs = DEFAULT_ENSURE_COMMS_SCOPE_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`ensure_comms_for_scope timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resolveMcpShimStateRoot(options) {
  const env = options.env ?? process.env;
  const fromDir = options.fromDir ?? import.meta.dirname;
  const ctx = resolveEntryContext(fromDir, options.deps?.entryContextDeps);
  const resolvedEnv = ctx.projectRoot
    ? applyDevConfig(env, ctx.projectRoot, options.deps?.devConfigDeps).env
    : env;
  const resolveStatePathsFn = options.deps?.resolveStatePaths ?? resolveStatePaths;
  return (
    options.stateRoot ??
    resolvedEnv.AGENTS_COMM_BUS_ROOT ??
    resolveStatePathsFn({ stateRoot: resolvedEnv.AGENTS_COMM_BUS_STATE_ROOT }).root
  );
}

function randomHeartbeatDelayMs(minMs, maxMs, randomFn) {
  return minMs + Math.floor(randomFn() * (maxMs - minMs + 1));
}

async function pathExistsAsync(pathExistsFn, targetPath) {
  const result = pathExistsFn(targetPath);
  return result instanceof Promise ? result : result;
}

export function startEnsureCommsHeartbeat(options) {
  const minMs = options.minMs ?? DEFAULT_HEARTBEAT_MIN_MS;
  const maxMs = options.maxMs ?? DEFAULT_HEARTBEAT_MAX_MS;
  const randomFn = options.deps?.random ?? Math.random;
  const scheduleTimer = options.deps?.scheduleTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs));
  const pathExistsFn = options.deps?.pathExists ?? existsSync;
  const ensureAtStartup = options.deps?.ensureCommsForScopeAtStartup ?? ensureCommsForScopeAtStartup;
  const logFn = options.deps?.log ?? log;

  let stopped = false;
  let timer = null;
  let loggedFailure = false;

  const resolveStateRoot = () =>
    options.resolveStateRoot?.() ?? resolveMcpShimStateRoot(options);

  async function isPaused() {
    try {
      const stateRoot = resolveStateRoot();
      return await pathExistsAsync(pathExistsFn, join(stateRoot, "paused"));
    } catch {
      return false;
    }
  }

  function scheduleNext() {
    if (stopped) return;
    const delayMs = randomHeartbeatDelayMs(minMs, maxMs, randomFn);
    timer = scheduleTimer(() => {
      void tick();
    }, delayMs);
    timer?.unref?.();
  }

  async function tick() {
    if (stopped) return;
    timer = null;
    try {
      if (await isPaused()) {
        scheduleNext();
        return;
      }
      const result = await ensureAtStartup({
        ...options,
        logFailures: false,
      });
      if (result.ok) {
        loggedFailure = false;
      } else if (!loggedFailure) {
        logFn(
          `ensure_comms_for_scope heartbeat failed: ${result.message} (suppressing until success)`,
        );
        loggedFailure = true;
      }
    } catch (error) {
      if (!loggedFailure) {
        logFn(
          `ensure_comms_for_scope heartbeat failed: ${
            error instanceof Error ? error.message : String(error)
          } (suppressing until success)`,
        );
        loggedFailure = true;
      }
    }
    scheduleNext();
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer != null) {
        if (typeof timer.cancel === "function") {
          timer.cancel();
        } else {
          clearTimeout(timer);
        }
        timer = null;
      }
    },
  };
}

export async function ensureCommsForScopeAtStartup(options) {
  const project = options.resolveProject?.() ?? resolveMcpShimProject(options.env);
  const agent = options.agentInUse();
  const requestEnsure = options.deps?.requestEnsure ?? defaultEnsureCommsForScopeRequest;
  const timeoutMs = options.startupEnsureTimeoutMs ?? DEFAULT_ENSURE_COMMS_SCOPE_TIMEOUT_MS;
  const connectionRef = { current: null };
  try {
    await runWithStartupEnsureTimeout(
      () => requestEnsure({ ...options, connectionRef }, { project, agent }),
      timeoutMs,
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.logFailures !== false) {
      log(`ensure_comms_for_scope at startup failed: ${message}`);
    }
    return { ok: false, message };
  } finally {
    connectionRef.current?.close();
  }
}

async function defaultEnsureCommsForScopeRequest(options, { project, agent }) {
  const { metadata, ensured } = await ensureMcpRuntime(options);
  const connection = await connectIpc({
    port: ensured.port,
    clientVersion: DAEMON_VERSION,
    metadata: {
      ...metadata,
      operation: "ensure_comms_for_scope",
      project,
      agent,
    },
  });
  options.connectionRef.current = connection;
  try {
    await connection.request("ensure_comms_for_scope", { project, agent });
  } finally {
    if (options.connectionRef.current === connection) {
      connection.close();
      options.connectionRef.current = null;
    }
  }
}

export function createDaemonRequester(options) {
  return async function daemonRequest(method, params = {}) {
    await options.beforeDaemonRequest?.();
    const { metadata, ensured } = await ensureMcpRuntime(options);
    const connection = await connectIpc({
      port: ensured.port,
      clientVersion: DAEMON_VERSION,
      metadata,
    });
    try {
      return await connection.request(method, {
        session: options.sessionInUse(),
        ...params,
      });
    } finally {
      connection.close();
    }
  };
}

export function createMcpServer({ daemonRequest }) {
  const server = new Server(
    { name: "agents-comm-mcp-shim", version: "2.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "comm_send_message",
        description: "Send a text message via the agents-comm-bus daemon. `comm` selects which platform adapter delivers the message. Best practice: OMIT `target` to reply to the session's most-recent-inbound conversation — that routes by concrete identity automatically. Only set `target` to send somewhere else.",
        inputSchema: {
          type: "object",
          properties: {
            comm: { type: "string", description: "Comm adapter id to route through. Must match a registered comm." },
            message: { type: "string", description: "The message text to send" },
            target: {
              type: "object",
              description: "Optional explicit target. Shape: { chat_native_id, thread_native_id?, account? }. `account` MUST be a concrete bot id (the `account=<id>` value in your inbound block, or `bot=<id>` from list_conversations) — account LABELS like \"main\" are rejected, they are ambiguous across agents. Omit `target` entirely to reply to your most-recent inbound.",
              properties: {
                chat_native_id: { type: ["string", "number"] },
                thread_native_id: { type: ["string", "number"] },
                account: { type: ["string", "number"], description: "Concrete bot id only (not an account label)." },
              },
            },
          },
          required: ["comm", "message"],
        },
      },
      {
        name: "comm_send_attachment",
        description: "Send a file/image attachment via the agents-comm-bus daemon. Same `comm`/`target` semantics as `comm_send_message`. The adapter handles platform-specific upload mechanics.",
        inputSchema: {
          type: "object",
          properties: {
            comm: { type: "string", description: "Comm to route through." },
            path: { type: "string", description: "Absolute path to the file/image" },
            caption: { type: "string", description: "Optional caption rendered alongside the attachment (mapping is comm-specific)." },
            target: {
              type: "object",
              description: "Optional explicit target. Shape: { chat_native_id, thread_native_id?, account? }. `account` MUST be a concrete bot id (not an account label like \"main\" — labels are rejected). Omit `target` to reply to your most-recent inbound.",
              properties: {
                chat_native_id: { type: ["string", "number"] },
                thread_native_id: { type: ["string", "number"] },
                account: { type: ["string", "number"], description: "Concrete bot id only (not an account label)." },
              },
            },
          },
          required: ["comm", "path"],
        },
      },
      {
        name: "comm_check_messages",
        description: "Drain pending inbound messages from the agents-comm-bus daemon, optionally filtered by `comm`.",
        inputSchema: {
          type: "object",
          properties: {
            comm: { type: "string", description: "Optional comm filter; when omitted all pending inbound messages across comms are returned." },
          },
          required: [],
        },
      },
      {
        name: "list_conversations",
        description: "List conversation inventory from the agents-comm-bus daemon.",
        inputSchema: {
          type: "object",
          properties: {
            comm: { type: "string", description: "Optional comm filter." },
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
      if (name === "comm_send_message") {
        return await handleSendMessage(daemonRequest, args);
      }

      if (name === "comm_send_attachment") {
        return await handleSendAttachment(daemonRequest, args);
      }

      if (name === "comm_check_messages") {
        return await handleCheckMessages(daemonRequest, args);
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

  return server;
}

export async function handleSendMessage(daemonRequest, args) {
  if (!args.comm) return toolError("Error: comm is required");
  if (!args.message) return toolError("Error: message is required");
  const params = { message: args.message, target: args.target };
  const result = await daemonRequest(`${args.comm}_send`, params);
  return toolText(`Message sent via agents-comm-bus (${result.message_id})`);
}

export async function handleSendAttachment(daemonRequest, args) {
  if (!args.comm) return toolError("Error: comm is required");
  if (!args.path) return toolError("Error: path is required");
  if (!existsSync(args.path)) return toolError(`Error: File not found: ${args.path}`);
  const params = {
    path: args.path,
    caption: args.caption,
    target: args.target,
  };
  const result = await daemonRequest(`${args.comm}_send_image`, params);
  return toolText(`Attachment sent via agents-comm-bus (${result.message_id})`);
}

export async function handleCheckMessages(daemonRequest, args) {
  // Scoped drain: when `comm` is supplied, the daemon removes only matching
  // entries; entries for other comms stay queued. Without this scoping a
  // filtered check would destructively drain every comm's pending inbound
  // and merely filter results client-side, losing the other comms' messages.
  const params = args.comm ? { comm: args.comm } : {};
  const messages = await daemonRequest("drain_pending_inbound", params);
  if (!messages.length) {
    return toolText(`No pending messages${args.comm ? ` from ${args.comm}` : ""}`);
  }
  return toolText(formatMessages(messages));
}

export function toolText(text) {
  return { content: [{ type: "text", text }] };
}

export function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

export function formatMessages(items) {
  return `${items.length} pending message(s):\n\n${items.map((item) => {
    const message = item.message;
    const comm = message?.chat?.comm ?? "unknown";
    const time = new Date(message.received_at).toLocaleTimeString();
    const from = message.sender?.display_name ?? message.sender?.id ?? "User";
    const attachments = message.attachments?.length ? ` [${message.attachments.length} attachment(s)]` : "";
    return `[${time}] (${comm}) ${from}: ${message.text ?? ""}${attachments}`;
  }).join("\n")}`;
}

export function formatConversations(conversations) {
  return conversations.map((conversation) => {
    const thread = conversation.thread_native_id ? `:${conversation.thread_native_id}` : "";
    const last = conversation.last_inbound_at ?? conversation.last_outbound_at;
    const lastText = last ? new Date(last).toISOString() : "no activity";
    // Surface bot_user_id explicitly: it is the routing key for comm_send_message
    // (target.account). account_label is human metadata, not a send target (AGE-15).
    const botId = conversation.bot_user_id ?? "unknown";
    return `${conversation.comm} bot=${botId} chat_native_id=${conversation.chat_native_id}${thread} agent=${conversation.agent} account_label=${conversation.account_label} last=${lastText}`;
  }).join("\n");
}

export async function runMcpShim(options) {
  const daemonRequest = createDaemonRequester(options);
  const server = createMcpServer({ daemonRequest });

  await options.beforeConnect?.();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP shim connected via stdio");
  options.afterConnect?.();
}

export function installShutdownHandlers(close) {
  process.once("exit", close);
  process.once("SIGINT", () => {
    close();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(143);
  });
}
