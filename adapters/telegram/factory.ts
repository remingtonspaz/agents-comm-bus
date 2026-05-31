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
  AccountId,
  AccountRegistration,
  ChatRef,
  CommAdapter,
  CommId,
  SessionId,
} from "agents-comm-bus-core";

import type { MessageBus } from "../../core-daemon/bus.js";
import type {
  CommAdapterFactory,
  CommAdapterCreateContext,
  CommAdapterFactoryEnv,
  CommIpcDeps,
  ResolveCredentialsContext,
} from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
import { TelegramCommAdapter, probeTelegramIdentity } from "./adapter.js";

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
    context?: ResolveCredentialsContext,
  ): Promise<{ credentials: Record<string, unknown> } | undefined> {
    const ref = registration.credentials_ref ?? "";
    const envAllowed = normalizeCsv(env.TELEGRAM_USER_ID);
    const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);

    if (ref.startsWith("env:")) {
      const name = ref.slice("env:".length);
      const fromEnv = name ? env[name] : undefined;
      if (fromEnv) {
        return {
          credentials: {
            botToken: fromEnv,
            allowedUserIds: mergeAllowed(envAllowed, undefined, dbAllowed),
          },
        };
      }
      const fromFile = await readProjectTelegramConfig(registration.project, registration.agent);
      if (fromFile?.botToken) {
        return {
          credentials: {
            botToken: fromFile.botToken,
            allowedUserIds: mergeAllowed(envAllowed, fromFile.userId, dbAllowed),
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
            allowedUserIds: mergeAllowed(envAllowed, fromFile.userId, dbAllowed),
          },
        };
      }
      return undefined;
    }

    return undefined;
  }

  async fallbackFromEnv(
    env: CommAdapterFactoryEnv,
  ): Promise<{ credentials: Record<string, unknown>; accountId: AccountId } | undefined> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return undefined;
    let identity;
    try {
      identity = await probeTelegramIdentity(token);
    } catch {
      return undefined;
    }
    return {
      credentials: {
        botToken: token,
        allowedUserIds: normalizeCsv(env.TELEGRAM_USER_ID),
      },
      accountId: identity.bot_user_id as AccountId,
    };
  }

  create(
    credentials: Record<string, unknown>,
    accountId: AccountId,
    context?: CommAdapterCreateContext,
  ): CommAdapter {
    const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
    if (!botToken) {
      throw new Error("TelegramCommAdapterFactory.create: credentials.botToken is required");
    }
    const allowed = Array.isArray(credentials.allowedUserIds)
      ? (credentials.allowedUserIds as string[]).map(String)
      : [];
    return new TelegramCommAdapter({
      botToken,
      accountId,
      allowedUserIds: allowed,
      attachmentBlobStore: context?.blobs,
    });
  }

  ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler> {
    return new Map<string, IpcMethodHandler>([
      [
        "telegram_send",
        async (params: Record<string, unknown>) => sendTelegram(deps, params, false),
      ],
      [
        "telegram_send_image",
        async (params: Record<string, unknown>) => sendTelegram(deps, params, true),
      ],
      [
        "telegram_check_messages",
        async () => deps.pendingInbound.splice(0),
      ],
    ]);
  }
}

export function createCommAdapterFactory(): CommAdapterFactory {
  return new TelegramCommAdapterFactory();
}

async function sendTelegram(
  deps: CommIpcDeps,
  params: Record<string, unknown>,
  image: boolean,
): Promise<{ message_id: string }> {
  const chatNativeId = extractChatNativeId(params);
  const target = chatNativeId === null
    ? undefined
    : await targetFromParams(deps.storage, params, chatNativeId);
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

/**
 * Pull the chat identifier from either the generic nested `target.chat_native_id`
 * shape (the form the comm-agnostic MCP shim sends) or the legacy flat `chat_id`
 * shape (still accepted for callers that haven't migrated). Returns `null` when
 * neither form is present — caller should fall back to the session's
 * most-recent-inbound conversation.
 */
function extractChatNativeId(params: Record<string, unknown>): string | null {
  if (params.chat_id != null) return String(params.chat_id);
  const target = params.target;
  if (target && typeof target === "object" && "chat_native_id" in target) {
    const value = (target as Record<string, unknown>).chat_native_id;
    if (value != null) return String(value);
  }
  return null;
}

function extractThreadNativeId(params: Record<string, unknown>): string | undefined {
  if (params.message_thread_id != null) return String(params.message_thread_id);
  const target = params.target;
  if (target && typeof target === "object" && "thread_native_id" in target) {
    const value = (target as Record<string, unknown>).thread_native_id;
    if (value != null) return String(value);
  }
  return undefined;
}

async function targetFromParams(
  storage: CommIpcDeps["storage"],
  params: Record<string, unknown>,
  chatNativeId: string,
): Promise<ChatRef> {
  const explicitAccount = extractTargetAccount(params);
  if (explicitAccount != null) {
    return {
      comm: TELEGRAM_COMM_ID,
      account: explicitAccount as ChatRef["account"],
      chat_native_id: chatNativeId,
      thread_native_id: extractThreadNativeId(params),
    };
  }

  const session = typeof params.session === "string"
    ? await storage.getSession(params.session as SessionId)
    : null;
  const scoped = session
    ? await storage.listAccountRegistrations({
        project: session.project,
        comm: TELEGRAM_COMM_ID,
        agent: session.agent,
      })
    : [];
  const registration = scoped[0] ?? (
    await storage.listAccountRegistrations({ comm: TELEGRAM_COMM_ID })
  )[0];
  if (!registration) {
    throw new Error("no Telegram account registration exists; run agents-comm-bus account-add first");
  }
  return {
    comm: TELEGRAM_COMM_ID,
    account: registration.bot_user_id as ChatRef["account"],
    chat_native_id: chatNativeId,
    thread_native_id: extractThreadNativeId(params),
  };
}

function extractTargetAccount(params: Record<string, unknown>): string | undefined {
  const target = params.target;
  if (target && typeof target === "object" && "account" in target) {
    const value = (target as Record<string, unknown>).account;
    if (value != null) return String(value);
  }
  return undefined;
}

function normalizeCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function mergeAllowed(
  fromEnv: string[],
  fromFile: string[] | undefined,
  fromDb: string[] | undefined = undefined,
): string[] {
  const out = [...fromEnv];
  const sources: Array<string[] | undefined> = [fromFile, fromDb];
  for (const source of sources) {
    if (!source) continue;
    for (const id of source) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

async function readAllowlistFromDb(
  context: ResolveCredentialsContext | undefined,
  bot_user_id: string,
): Promise<string[]> {
  if (!context?.storage) return [];
  const [globals, perBot] = await Promise.all([
    context.storage.listAllowlistGlobal({ comm: TELEGRAM_COMM_ID }),
    context.storage.listAllowlistPerBot({ comm: TELEGRAM_COMM_ID, bot_user_id }),
  ]);
  const out: string[] = [];
  for (const row of globals) {
    if (!out.includes(row.sender_id)) out.push(row.sender_id);
  }
  for (const row of perBot) {
    if (!out.includes(row.sender_id)) out.push(row.sender_id);
  }
  return out;
}

async function readProjectTelegramConfig(
  project: string,
  agent: string,
): Promise<{ botToken?: string; userId?: string[] } | undefined> {
  const agentConfig = await readJsonTelegramConfig(path.join(project, `.${agent}`, "telegram.json"));
  if (agentConfig) return agentConfig;
  if (agent !== "claude") {
    return readJsonTelegramConfig(path.join(project, ".claude", "telegram.json"));
  }
  return undefined;
}

async function readJsonTelegramConfig(
  filePath: string,
): Promise<{ botToken?: string; userId?: string[] } | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { botToken?: unknown; userId?: unknown };
    const botToken = typeof parsed.botToken === "string" ? parsed.botToken : undefined;
    const userId = normalizeUserIdField(parsed.userId);
    if (!botToken && userId.length === 0) return undefined;
    return { botToken, userId: userId.length > 0 ? userId : undefined };
  } catch {
    return undefined;
  }
}

function normalizeUserIdField(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : ""))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return [raw.trim()].filter(Boolean);
  if (typeof raw === "number") return [String(raw)];
  return [];
}
