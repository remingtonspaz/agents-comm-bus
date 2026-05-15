#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ensureDaemon } from "../agents-comm-bus/dist/bootstrap/ensure-daemon.js";
import { connectIpc } from "../agents-comm-bus/dist/ipc/client.js";
import { DAEMON_VERSION } from "../agents-comm-bus/dist/config.js";

function log(message) {
  console.error(`[telegram-mcp] ${message}`);
}

async function daemonRequest(method, params = {}) {
  const ensured = await ensureDaemon({
    clientVersion: DAEMON_VERSION,
    metadata: {
      shimName: "telegram-mcp-server",
      agent: process.env.AGENTS_COMM_BUS_AGENT ?? "claude",
      project: process.cwd(),
    },
  });
  const connection = await connectIpc({
    port: ensured.port,
    clientVersion: DAEMON_VERSION,
    metadata: {
      shimName: "telegram-mcp-server",
      agent: process.env.AGENTS_COMM_BUS_AGENT ?? "claude",
      project: process.cwd(),
    },
  });
  try {
    return await connection.request(method, {
      session: process.env.AGENTS_COMM_BUS_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? "mcp",
      ...params,
    });
  } finally {
    connection.close();
  }
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP shim connected via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
