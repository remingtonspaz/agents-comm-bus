#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import crypto from "node:crypto";

import {
  SCHEMA_VERSION_SESSION,
  type AccountRegistration,
  type AgentId,
  type ChatRef,
  type CommId,
  type Conversation,
  type Message,
  type Query,
  type QueryId,
  type SessionId,
} from "../../agents-comm-bus-core/dist/index.js";
import { DAEMON_VERSION } from "./config.js";
import { resolveStatePaths } from "./paths.js";
import { startIpcServer } from "./ipc/server.js";
import type { IpcRequest } from "./ipc/protocol.js";
import { writeDaemonDiscoveryFiles } from "./bootstrap/ensure-daemon.js";
import { MessageBus } from "./bus.js";
import { TelegramCommAdapter } from "./adapters/comm/telegram.js";
import { openSqliteStorage } from "./storage/sqlite.js";
import { JsonlTranscriptStore } from "./storage/transcripts.js";
import { JsonlAuditStore } from "./storage/audit.js";
import { ContentAddressedBlobStore } from "./storage/blobs.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const paths = resolveStatePaths({ stateRoot: process.env.AGENTS_COMM_BUS_STATE_ROOT });

  if (argv.includes("--print-paths")) {
    console.log(JSON.stringify(paths, null, 2));
    return;
  }

  await mkdir(paths.root, { recursive: true });
  const storage = await openSqliteStorage(paths.database);
  const transcripts = new JsonlTranscriptStore(paths.root);
  const audit = new JsonlAuditStore(paths.root);
  const blobs = new ContentAddressedBlobStore(paths.root);
  const pendingInbound: Array<{ message: Message; conversation: Conversation }> = [];
  const comms = [];
  const attachedBotIds = new Set<string>();

  const registrations = await storage.listAccountRegistrations({ comm: "telegram" as CommId });
  for (const registration of registrations) {
    if (attachedBotIds.has(registration.bot_user_id)) continue;
    const resolved = await resolveTelegramCredentials(registration);
    if (!resolved) {
      console.error(
        `agents-comm-bus: skipping telegram account ${registration.account_label} ` +
          `for project ${registration.project} (could not resolve credentials_ref=${registration.credentials_ref})`,
      );
      continue;
    }
    comms.push(new TelegramCommAdapter({
      botToken: resolved.botToken,
      allowedUserIds: resolved.allowedUserIds,
    }));
    attachedBotIds.add(registration.bot_user_id);
  }

  if (comms.length === 0) {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    if (telegramToken) {
      comms.push(new TelegramCommAdapter({
        botToken: telegramToken,
        allowedUserIds: normalizeCsv(process.env.TELEGRAM_USER_ID),
      }));
    }
  }

  const bus = new MessageBus({
    project: process.cwd(),
    storage,
    transcripts,
    audit,
    blobs,
    comms,
  });
  bus.setDispatchSink({
    async enqueueInbound(message, conversation) {
      pendingInbound.push({ message, conversation });
      if (pendingInbound.length > 100) pendingInbound.splice(0, pendingInbound.length - 100);
    },
  });

  const server = await startIpcServer({
    metadata: {
      stateRoot: paths.root,
    },
    onRequest: async (request, socket) => handleIpcRequest(request, {
      bus,
      storage,
      pendingInbound,
      socket,
    }),
  });
  await writeDaemonDiscoveryFiles({ stateRoot: paths.root, port: server.port });
  await bus.start();

  console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
}

async function handleIpcRequest(
  request: IpcRequest,
  context: {
    bus: MessageBus;
    storage: Awaited<ReturnType<typeof openSqliteStorage>>;
    pendingInbound: Array<{ message: Message; conversation: Conversation }>;
    socket?: { once(event: "close", handler: () => void): void };
  },
): Promise<unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>;
  switch (request.method) {
    case "list_conversations":
      return context.bus.listConversations({
        comm: params.comm as CommId | undefined,
        limit: typeof params.limit === "number" ? params.limit : 25,
      });
    case "telegram_check_messages": {
      const drained = context.pendingInbound.splice(0);
      return drained.map(({ message, conversation }) => ({ message, conversation }));
    }
    case "claude_register_session":
      return registerClaudeSession(context, params);
    case "claude_drain_inbound":
      return drainClaudeInbound(context, params);
    case "claude_open_query":
      return openClaudeQuery(context, params);
    case "telegram_send":
      return sendTelegram(context, params, false);
    case "telegram_send_image":
      return sendTelegram(context, params, true);
    default:
      throw new Error(`unknown IPC method: ${request.method}`);
  }
}

async function registerClaudeSession(
  context: {
    storage: Awaited<ReturnType<typeof openSqliteStorage>>;
    socket?: { once(event: "close", handler: () => void): void };
  },
  params: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
  const session = requiredString(params.session, "session") as SessionId;
  const project = requiredString(params.project, "project");
  const connectionId = typeof params.connection_id === "string"
    ? params.connection_id
    : `claude:${session}:${crypto.randomUUID()}`;
  const now = Date.now();
  await context.storage.upsertSession({
    schema_version: SCHEMA_VERSION_SESSION,
    session_id: session,
    agent: "claude" as AgentId,
    project,
    created_at: now,
    lease_holder_connection_id: null,
    lease_acquired_at: null,
    lease_released_at: null,
    most_recent_inbound_conversation_id: null,
    status: "active",
  });
  const acquired = await context.storage.acquireSessionLease(session, connectionId, now);
  if (!acquired) {
    return { ok: false, reason: "same-project claude session lease already held" };
  }
  context.socket?.once("close", () => {
    void context.storage.releaseSessionLease(session, connectionId, Date.now());
  });
  return { ok: true };
}

async function drainClaudeInbound(
  context: {
    storage: Awaited<ReturnType<typeof openSqliteStorage>>;
    pendingInbound: Array<{ message: Message; conversation: Conversation }>;
  },
  params: Record<string, unknown>,
): Promise<Array<{ message: Message; conversation: Conversation }>> {
  const session = typeof params.session === "string" ? params.session as SessionId : undefined;
  const drained = context.pendingInbound.splice(0);
  if (session && drained.length > 0) {
    await context.storage.setSessionMostRecentInbound(
      session,
      drained[drained.length - 1].conversation.conversation_id,
    );
  }
  return drained;
}

async function openClaudeQuery(
  context: {
    bus: MessageBus;
    storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  },
  params: Record<string, unknown>,
): Promise<{
  query_id: QueryId;
  hook_response: unknown;
  hookJson: unknown;
  nativeHookJson: unknown;
}> {
  const session = requiredString(params.session, "session") as SessionId;
  const queryInput = recordOrEmpty(params.query);
  const claudeInput = recordOrEmpty(params.claude);
  const toolName = typeof params.tool_name === "string"
    ? params.tool_name
    : typeof claudeInput.tool_name === "string"
      ? claudeInput.tool_name
      : undefined;
  const promptText = requiredString(params.prompt_text ?? queryInput.prompt_text, "prompt_text");
  const rawKind = params.kind ?? queryInput.kind;
  const kind = (rawKind === "choice" || rawKind === "freetext" || rawKind === "approval")
    ? rawKind
    : "approval";
  const queryId = `q_${crypto.randomUUID()}` as QueryId;
  const sessionRecord = await context.storage.getSession(session);
  const conversation = sessionRecord?.most_recent_inbound_conversation_id
    ? await context.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
    : null;
  const originChat = conversation ? {
    comm: conversation.comm,
    account: conversation.account_label as ChatRef["account"],
    chat_native_id: conversation.chat_native_id,
    thread_native_id: conversation.thread_native_id ?? undefined,
  } satisfies ChatRef : undefined;
  const query: Query = {
    schema_version: 1,
    query_id: queryId,
    agent: "claude" as AgentId,
    session,
    kind,
    prompt_text: promptText,
    options: Array.isArray(params.options)
      ? params.options.map(String)
      : Array.isArray(queryInput.options)
        ? queryInput.options.map(String)
        : undefined,
    origin_chat: originChat,
    created_at: Date.now(),
    ttl_seconds: typeof params.ttl_seconds === "number" ? params.ttl_seconds : 300,
  };
  await context.bus.openQuery(query);
  if (originChat) {
    await context.bus.send({
      session,
      comm: originChat.comm,
      target: originChat,
      payload: { text: promptText },
      idempotencyKey: `query:${queryId}`,
    });
  }

  const hookResponse = hookResponseForUnresolvedClaudeQuery({ ...params, tool_name: toolName });
  return {
    query_id: queryId,
    hook_response: hookResponse,
    hookJson: hookResponse,
    nativeHookJson: hookResponse,
  };
}

async function sendTelegram(
  context: {
    bus: MessageBus;
    storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  },
  params: Record<string, unknown>,
  image: boolean,
): Promise<{ message_id: string }> {
  const target = params.chat_id == null ? undefined : await targetFromParams(context.storage, params);
  const sent = await context.bus.send({
    session: String(params.session ?? "mcp") as SessionId,
    comm: "telegram" as CommId,
    target,
    payload: image
      ? {
          text: typeof params.caption === "string" ? params.caption : undefined,
          attachments: [{
            filename: String(params.path),
            local_path: String(params.path),
            mime: "application/octet-stream",
            size: 0,
          }],
        }
      : { text: String(params.message ?? "") },
    idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
  });
  return { message_id: sent };
}

async function targetFromParams(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  params: Record<string, unknown>,
): Promise<ChatRef> {
  if (params.chat_id == null) {
    throw new Error("omitted Telegram target requires a session most-recent-inbound conversation");
  }
  const registration = (await storage.listAccountRegistrations({
    comm: "telegram" as CommId,
  }))[0];
  if (!registration) {
    throw new Error("no Telegram account registration exists; run agents-comm-bus account-add first");
  }
  return {
    comm: "telegram" as CommId,
    account: registration.bot_user_id as ChatRef["account"],
    chat_native_id: String(params.chat_id),
    thread_native_id: params.message_thread_id == null ? undefined : String(params.message_thread_id),
  };
}

function normalizeCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function resolveTelegramCredentials(
  registration: AccountRegistration,
): Promise<{ botToken: string; allowedUserIds: string[] } | undefined> {
  const ref = registration.credentials_ref ?? "";
  const envAllowed = normalizeCsv(process.env.TELEGRAM_USER_ID);

  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const fromEnv = name ? process.env[name] : undefined;
    if (fromEnv) {
      return { botToken: fromEnv, allowedUserIds: envAllowed };
    }
    const fromFile = await readProjectTelegramConfig(registration.project);
    if (fromFile?.botToken) {
      return {
        botToken: fromFile.botToken,
        allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
      };
    }
    return undefined;
  }

  if (ref.startsWith("file:")) {
    const fromFile = await readJsonTelegramConfig(ref.slice("file:".length));
    if (fromFile?.botToken) {
      return {
        botToken: fromFile.botToken,
        allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
      };
    }
    return undefined;
  }

  return undefined;
}

async function readProjectTelegramConfig(
  project: string,
): Promise<{ botToken?: string; userId?: string } | undefined> {
  return readJsonTelegramConfig(path.join(project, ".claude", "telegram.json"));
}

async function readJsonTelegramConfig(
  filePath: string,
): Promise<{ botToken?: string; userId?: string } | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { botToken?: unknown; userId?: unknown };
    const botToken = typeof parsed.botToken === "string" ? parsed.botToken : undefined;
    const userId = typeof parsed.userId === "string"
      ? parsed.userId
      : typeof parsed.userId === "number"
        ? String(parsed.userId)
        : undefined;
    if (!botToken && !userId) return undefined;
    return { botToken, userId };
  } catch {
    return undefined;
  }
}

function mergeAllowed(fromEnv: string[], fromFile: string | undefined): string[] {
  if (!fromFile) return fromEnv;
  return fromEnv.includes(fromFile) ? fromEnv : [...fromEnv, fromFile];
}

function requiredString(paramsValue: unknown, name: string): string {
  if (typeof paramsValue !== "string" || paramsValue.length === 0) {
    throw new Error(`${name} is required`);
  }
  return paramsValue;
}

function hookResponseForUnresolvedClaudeQuery(params: Record<string, unknown>): unknown {
  if (params.tool_name === "AskUserQuestion") {
    return { decision: { behavior: "allow" } };
  }
  return { decision: { behavior: "ask" } };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
