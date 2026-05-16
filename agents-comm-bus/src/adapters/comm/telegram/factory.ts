/**
 * Telegram comm adapter factory + IPC method surface.
 *
 * Concentrates everything Telegram-specific in one place so daemon.ts can
 * stay adapter-agnostic. Owns:
 *   - credential resolution from account_registrations (env / file refs)
 *   - dev-mode env fallback (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`)
 *   - the project-local `.claude/telegram.json` reader (legacy convention)
 *   - the MCP-tool IPC method surface: telegram_send, telegram_send_image,
 *     telegram_check_messages
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AccountRegistration,
  ChatRef,
  CommAdapter,
  CommId,
  SessionId,
} from "../../../../../agents-comm-bus-core/dist/index.js";

import type { MessageBus } from "../../../bus.js";
import type {
  CommAdapterFactory,
  CommAdapterFactoryEnv,
  CommIpcDeps,
} from "../../../runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../../runtime/ipc-method.js";
import { TelegramCommAdapter } from "./adapter.js";

const TELEGRAM_COMM_ID = "telegram" as CommId;

export interface TelegramCredentials {
  botToken: string;
  allowedUserIds: string[];
}

export class TelegramCommAdapterFactory implements CommAdapterFactory {
  readonly commId = TELEGRAM_COMM_ID;

  async resolveCredentials(
    registration: AccountRegistration,
    env: CommAdapterFactoryEnv,
  ): Promise<{ credentials: Record<string, unknown> } | undefined> {
    const ref = registration.credentials_ref ?? "";
    const envAllowed = normalizeCsv(env.TELEGRAM_USER_ID);

    if (ref.startsWith("env:")) {
      const name = ref.slice("env:".length);
      const fromEnv = name ? env[name] : undefined;
      if (fromEnv) {
        return { credentials: { botToken: fromEnv, allowedUserIds: envAllowed } };
      }
      const fromFile = await readProjectTelegramConfig(registration.project);
      if (fromFile?.botToken) {
        return {
          credentials: {
            botToken: fromFile.botToken,
            allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
          },
        };
      }
      return undefined;
    }

    if (ref.startsWith("file:")) {
      const fromFile = await readJsonTelegramConfig(ref.slice("file:".length));
      if (fromFile?.botToken) {
        return {
          credentials: {
            botToken: fromFile.botToken,
            allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
          },
        };
      }
      return undefined;
    }

    return undefined;
  }

  fallbackFromEnv(env: CommAdapterFactoryEnv): { credentials: Record<string, unknown> } | undefined {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return undefined;
    return {
      credentials: {
        botToken: token,
        allowedUserIds: normalizeCsv(env.TELEGRAM_USER_ID),
      },
    };
  }

  create(credentials: Record<string, unknown>): CommAdapter {
    const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
    if (!botToken) {
      throw new Error("TelegramCommAdapterFactory.create: credentials.botToken is required");
    }
    const allowed = Array.isArray(credentials.allowedUserIds)
      ? (credentials.allowedUserIds as string[]).map(String)
      : [];
    return new TelegramCommAdapter({ botToken, allowedUserIds: allowed });
  }

  ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler> {
    return new Map<string, IpcMethodHandler>([
      [
        "telegram_send",
        async (params) => sendTelegram(deps, params, false),
      ],
      [
        "telegram_send_image",
        async (params) => sendTelegram(deps, params, true),
      ],
      [
        "telegram_check_messages",
        async () => deps.pendingInbound.splice(0),
      ],
    ]);
  }
}

async function sendTelegram(
  deps: CommIpcDeps,
  params: Record<string, unknown>,
  image: boolean,
): Promise<{ message_id: string }> {
  const target = params.chat_id == null
    ? undefined
    : await targetFromParams(deps.storage, params);
  const sent = await deps.bus.send({
    session: String(params.session ?? "mcp") as SessionId,
    comm: TELEGRAM_COMM_ID,
    target,
    payload: image
      ? {
          text: typeof params.caption === "string" ? params.caption : undefined,
          attachments: [
            {
              filename: String(params.path),
              local_path: String(params.path),
              mime: "application/octet-stream",
              size: 0,
            },
          ],
        }
      : { text: String(params.message ?? "") },
    idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
  });
  return { message_id: sent };
}

async function targetFromParams(
  storage: CommIpcDeps["storage"],
  params: Record<string, unknown>,
): Promise<ChatRef> {
  if (params.chat_id == null) {
    throw new Error("omitted Telegram target requires a session most-recent-inbound conversation");
  }
  const registration = (
    await storage.listAccountRegistrations({ comm: TELEGRAM_COMM_ID })
  )[0];
  if (!registration) {
    throw new Error("no Telegram account registration exists; run agents-comm-bus account-add first");
  }
  return {
    comm: TELEGRAM_COMM_ID,
    account: registration.bot_user_id as ChatRef["account"],
    chat_native_id: String(params.chat_id),
    thread_native_id: params.message_thread_id == null ? undefined : String(params.message_thread_id),
  };
}

function normalizeCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function mergeAllowed(fromEnv: string[], fromFile: string | undefined): string[] {
  if (!fromFile) return fromEnv;
  return fromEnv.includes(fromFile) ? fromEnv : [...fromEnv, fromFile];
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
