import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { entryEnsures } from "./install/entry-ensures.js";
import { connectIpc } from "../../agents-comm-bus/dist/core-daemon/ipc/client.js";
import { PersistentIpcClient } from "../../agents-comm-bus/dist/core-daemon/ipc/persistent-client.js";
import { DAEMON_VERSION } from "../../agents-comm-bus/dist/core-daemon/config.js";

export { DAEMON_VERSION, PersistentIpcClient };

export function log(message) {
  console.error(`[acb-mcp] ${message}`);
}

export function spawnDaemonFromMcpShim(paths) {
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

export function resolveDaemonEntry() {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    // Source runtime: hosts/common/mcp-shim-shared.js -> repo root.
    new URL("../../agents-comm-bus/dist/core-daemon/serve.js", import.meta.url),
    // Bundled runtime: mcp-server/dist/<host>-mcp-shim.js -> repo root.
    new URL("../../agents-comm-bus/dist/core-daemon/serve.js", import.meta.url),
    // Compatibility fallback for older mcp-server/source layouts.
    new URL("../agents-comm-bus/dist/core-daemon/serve.js", import.meta.url),
  ].map((url) => fileURLToPath(url));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`agents-comm-bus daemon entry not found from ${here}; checked ${candidates.join(", ")}`);
  }
  return found;
}

export function createDaemonRequester(options) {
  return async function daemonRequest(method, params = {}) {
    await options.beforeDaemonRequest?.();
    const agent = options.agentInUse();
    const metadata = {
      shimName: options.shimName ?? "agents-comm-mcp-shim",
      agent,
      project: process.cwd(),
    };
    const ensured = await entryEnsures({
      fromDir: import.meta.dirname,
      agent,
      env: process.env,
      ensureDaemonOptions: {
        clientVersion: DAEMON_VERSION,
        metadata,
        spawnDaemon: options.spawnDaemon ?? spawnDaemonFromMcpShim,
      },
    });
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
        description: "Send a text message via the agents-comm-bus daemon. `comm` selects which platform adapter delivers the message. Target via the nested `target` object; omit to fall back to the session's most-recent-inbound conversation.",
        inputSchema: {
          type: "object",
          properties: {
            comm: { type: "string", description: "Comm adapter id to route through. Must match a registered comm." },
            message: { type: "string", description: "The message text to send" },
            target: {
              type: "object",
              description: "Optional target chat ref. Shape: { chat_native_id, thread_native_id?, account? }.",
              properties: {
                chat_native_id: { type: ["string", "number"] },
                thread_native_id: { type: ["string", "number"] },
                account: { type: ["string", "number"] },
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
              description: "Optional target chat ref. Shape: { chat_native_id, thread_native_id?, account? }.",
              properties: {
                chat_native_id: { type: ["string", "number"] },
                thread_native_id: { type: ["string", "number"] },
                account: { type: ["string", "number"] },
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
    return `${conversation.comm}/${conversation.account_label} ${conversation.chat_native_id}${thread} agent=${conversation.agent} last=${lastText}`;
  }).join("\n");
}

export async function runMcpShim(options) {
  const daemonRequest = createDaemonRequester(options);
  const server = createMcpServer({ daemonRequest });

  await options.beforeConnect?.();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP shim connected via stdio");
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
