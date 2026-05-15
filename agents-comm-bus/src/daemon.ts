#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { ChatRef, CommId, Conversation, Message, SessionId } from "../../agents-comm-bus-core/dist/index.js";
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
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    comms.push(new TelegramCommAdapter({
      botToken: telegramToken,
      allowedUserIds: normalizeCsv(process.env.TELEGRAM_USER_ID),
    }));
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
    onRequest: async (request) => handleIpcRequest(request, { bus, storage, pendingInbound }),
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
    case "telegram_send":
      return sendTelegram(context, params, false);
    case "telegram_send_image":
      return sendTelegram(context, params, true);
    default:
      throw new Error(`unknown IPC method: ${request.method}`);
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
