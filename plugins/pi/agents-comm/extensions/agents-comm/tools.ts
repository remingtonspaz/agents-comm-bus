/**
 * Pi-registered comm tools — mirror MCP shim semantics for cross-host skills.
 *
 * Registers:
 *   - `comm_send_message` — text outbound; `target` optional (omit to reply to
 *     most-recent inbound); `target.account` must be a concrete bot_user_id (AGE-15).
 *   - `comm_send_attachment` — file/image outbound; same target semantics.
 *   - `comm_check_messages` — drain pending inbound for the session.
 *   - `list_conversations` — conversation inventory from the daemon.
 */
import { existsSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DisconnectedError, PiDaemonClient } from "./daemon-client.js";
import { formatInboundMessages } from "./inbound-format.js";
import { piSessionId } from "./session-id.js";

const stringOrNumber = Type.Union([Type.String(), Type.Number()]);

const targetSchema = Type.Object({
  chat_native_id: stringOrNumber,
  thread_native_id: Type.Optional(stringOrNumber),
  account: Type.Optional(
    Type.Union([Type.String(), Type.Number()], {
      description:
        'Concrete bot id only (the account=<id> value in your inbound block, or bot=<id> from list_conversations) — account LABELS like "main" are rejected, they are ambiguous across agents.',
    }),
  ),
});

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

const NOT_CONNECTED = "agents-comm-bus not connected yet";

function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function isToolError(result: unknown): result is ToolResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    (result as ToolResult).isError === true
  );
}

async function withClient<T>(
  getClient: () => PiDaemonClient | null,
  fn: (client: PiDaemonClient) => Promise<T>,
): Promise<T | ToolResult> {
  const client = getClient();
  if (!client) {
    return toolError(NOT_CONNECTED);
  }
  try {
    return await fn(client);
  } catch (error) {
    if (error instanceof DisconnectedError) {
      return toolError(error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === "PiDaemonClient not started") {
      return toolError(NOT_CONNECTED);
    }
    throw error;
  }
}

function messageIdFromResult(result: unknown): string {
  if (result && typeof result === "object" && "message_id" in result) {
    return String((result as { message_id: unknown }).message_id);
  }
  return "unknown";
}

interface ConversationRecord {
  comm?: string;
  bot_user_id?: string;
  chat_native_id?: string | number;
  thread_native_id?: string | number;
  agent?: string;
  account_label?: string;
  last_inbound_at?: number;
  last_outbound_at?: number;
}

/** Port of `formatConversations` from `hosts/common/mcp-shim-shared.js`. */
export function formatConversations(conversations: ConversationRecord[]): string {
  return conversations
    .map((conversation) => {
      const thread = conversation.thread_native_id ? `:${conversation.thread_native_id}` : "";
      const last = conversation.last_inbound_at ?? conversation.last_outbound_at;
      const lastText = last ? new Date(last).toISOString() : "no activity";
      const botId = conversation.bot_user_id ?? "unknown";
      return `${conversation.comm} bot=${botId} chat_native_id=${conversation.chat_native_id}${thread} agent=${conversation.agent} account_label=${conversation.account_label} last=${lastText}`;
    })
    .join("\n");
}

/**
 * Register the four comm tools. `getClient` is invoked at tool execution time
 * (not registration time) because the daemon client is created in `session_start`.
 */
export function registerCommTools(
  pi: ExtensionAPI,
  getClient: () => PiDaemonClient | null,
): void {
  pi.registerTool({
    name: "comm_send_message",
    label: "Send Comm Message",
    description:
      "Send a text message via the agents-comm-bus daemon. `comm` selects which platform adapter delivers the message. Best practice: OMIT `target` to reply to the session's most-recent-inbound conversation — that routes by concrete identity automatically. Only set `target` to send somewhere else.",
    promptSnippet:
      "Send a text reply over a comm (Telegram/Discord/Matrix/curl). Omit target to reply to the most-recent inbound.",
    promptGuidelines: [
      "Use comm_send_message for user-visible remote replies over a comm — local terminal output is NOT seen by the remote user.",
      "When replying to an inbound message, omit target on comm_send_message to route back to the most-recent inbound conversation automatically.",
      'comm_send_message\'s target.account must be a concrete bot id (the account=<id> from your inbound block), never an account label like "main".',
    ],
    parameters: Type.Object({
      comm: Type.String({
        description: "Comm adapter id to route through. Must match a registered comm.",
      }),
      message: Type.String({ description: "The message text to send" }),
      target: Type.Optional(targetSchema),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!params.comm) return toolError("Error: comm is required");
      if (!params.message) return toolError("Error: message is required");

      const result = await withClient(getClient, (client) =>
        client.sendCommMessage({ comm: params.comm, text: params.message, target: params.target }),
      );
      if (isToolError(result)) return result;
      return toolText(`Message sent via agents-comm-bus (${messageIdFromResult(result)})`);
    },
  });

  pi.registerTool({
    name: "comm_send_attachment",
    label: "Send Comm Attachment",
    description:
      "Send a file/image attachment via the agents-comm-bus daemon. Same `comm`/`target` semantics as `comm_send_message`. The adapter handles platform-specific upload mechanics.",
    promptSnippet: "Send a file/image attachment over a comm.",
    promptGuidelines: [
      "Use comm_send_attachment to share a file or image with a remote user over a comm; it respects the same target semantics as comm_send_message.",
    ],
    parameters: Type.Object({
      comm: Type.String({ description: "Comm to route through." }),
      path: Type.String({ description: "Absolute path to the file/image" }),
      caption: Type.Optional(
        Type.String({
          description: "Optional caption rendered alongside the attachment (mapping is comm-specific).",
        }),
      ),
      target: Type.Optional(targetSchema),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!params.comm) return toolError("Error: comm is required");
      if (!params.path) return toolError("Error: path is required");
      if (!existsSync(params.path)) {
        return toolError(`Error: File not found: ${params.path}`);
      }

      const result = await withClient(getClient, (client) =>
        client.sendCommAttachment({
          comm: params.comm,
          path: params.path,
          caption: params.caption,
          target: params.target,
        }),
      );
      if (isToolError(result)) return result;
      return toolText(`Attachment sent via agents-comm-bus (${messageIdFromResult(result)})`);
    },
  });

  pi.registerTool({
    name: "comm_check_messages",
    label: "Check Comm Messages",
    description:
      "Drain pending inbound messages from the agents-comm-bus daemon, optionally filtered by `comm`.",
    promptSnippet: "Drain pending inbound comm messages (optionally filter by comm).",
    promptGuidelines: [
      "Use comm_check_messages when you suspect new inbound arrived since your last turn and no [Daemon Inbound Messages] block has appeared.",
    ],
    parameters: Type.Object({
      comm: Type.Optional(
        Type.String({
          description:
            "Optional comm filter; when omitted all pending inbound messages across comms are returned.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Session id from ctx.sessionManager (option 2) — fresh on each invocation for /new|/resume.
      const result = await withClient(getClient, (client) =>
        client.drainPiInbound({
          agent: "pi",
          session: piSessionId(ctx.sessionManager),
          project: ctx.cwd,
          comm: params.comm,
          limit: 100,
        }),
      );
      if (isToolError(result)) return result;

      const { messages } = result;
      if (!messages.length) {
        return toolText(`No pending messages${params.comm ? ` from ${params.comm}` : ""}`);
      }
      return toolText(formatInboundMessages(messages));
    },
  });

  pi.registerTool({
    name: "list_conversations",
    label: "List Conversations",
    description: "List conversation inventory from the agents-comm-bus daemon.",
    promptSnippet: "List conversation inventory from the daemon (surfaces bot_user_id routing keys).",
    promptGuidelines: [
      "Use list_conversations only when you need to target a conversation other than your most-recent inbound; the bot=<id> it surfaces is the concrete account to pass to comm_send_message's target.account.",
    ],
    parameters: Type.Object({
      comm: Type.Optional(Type.String({ description: "Optional comm filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum conversations to return" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await withClient(getClient, (client) =>
        client.listConversations({ comm: params.comm, limit: params.limit }),
      );
      if (isToolError(result)) return result;

      const conversations = Array.isArray(result) ? (result as ConversationRecord[]) : [];
      if (!conversations.length) {
        return toolText("No conversations found");
      }
      return toolText(formatConversations(conversations));
    },
  });
}
