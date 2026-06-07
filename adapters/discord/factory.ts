/**
 * Discord comm adapter factory + IPC method surface.
 */
import { readFile } from "node:fs/promises";

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
import { DiscordCommAdapter, probeDiscordIdentity } from "./adapter.js";

const DISCORD_COMM_ID = "discord" as CommId;

export interface DiscordCredentials {
  botToken: string;
  applicationId?: string;
  botUserId?: string;
}

export class DiscordCommAdapterFactory implements CommAdapterFactory {
  readonly commId = DISCORD_COMM_ID;

  async resolveCredentials(
    registration: AccountRegistration,
    _env: CommAdapterFactoryEnv,
    _context?: ResolveCredentialsContext,
  ): Promise<{ credentials: Record<string, unknown> } | undefined> {
    const ref = registration.credentials_ref ?? "";
    if (!ref.startsWith("file:")) {
      return undefined;
    }

    const fromFile = await readJsonDiscordConfig(ref.slice("file:".length));
    if (!fromFile?.botToken) {
      return undefined;
    }
    return {
      credentials: {
        botToken: fromFile.botToken,
        applicationId: fromFile.applicationId,
        botUserId: fromFile.botUserId,
      },
    };
  }

  async probeIdentity(
    credentials: Record<string, unknown>,
  ): Promise<{ accountId: AccountId; accountUsername?: string | null }> {
    const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
    if (!botToken) {
      throw new Error("DiscordCommAdapterFactory.probeIdentity: credentials.botToken is required");
    }
    const identity = await probeDiscordIdentity(botToken);
    return {
      accountId: identity.bot_user_id as AccountId,
      accountUsername: identity.bot_username ?? null,
    };
  }

  create(
    credentials: Record<string, unknown>,
    accountId: AccountId,
    _context?: CommAdapterCreateContext,
  ): CommAdapter {
    const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
    if (!botToken) {
      throw new Error("DiscordCommAdapterFactory.create: credentials.botToken is required");
    }
    const applicationId =
      typeof credentials.applicationId === "string" ? credentials.applicationId : undefined;
    return new DiscordCommAdapter({
      botToken,
      applicationId,
      accountId,
    });
  }

  ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler> {
    return new Map<string, IpcMethodHandler>([
      [
        "discord_send",
        async (params: Record<string, unknown>) => sendDiscord(deps, params),
      ],
    ]);
  }
}

export function createCommAdapterFactory(): CommAdapterFactory {
  return new DiscordCommAdapterFactory();
}

async function sendDiscord(
  deps: CommIpcDeps,
  params: Record<string, unknown>,
): Promise<{ message_id: string }> {
  const chatNativeId = extractChatNativeId(params);
  const target = chatNativeId === null
    ? undefined
    : await targetFromParams(deps.storage, params, chatNativeId);
  const sent = await deps.bus.send({
    session: String(params.session ?? "mcp") as SessionId,
    comm: DISCORD_COMM_ID,
    target,
    payload: { text: String(params.message ?? "") },
    idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
  });
  return { message_id: sent };
}

function extractChatNativeId(params: Record<string, unknown>): string | null {
  if (params.channel_id != null) return String(params.channel_id);
  const target = params.target;
  if (target && typeof target === "object" && "chat_native_id" in target) {
    const value = (target as Record<string, unknown>).chat_native_id;
    if (value != null) return String(value);
  }
  return null;
}

async function targetFromParams(
  storage: CommIpcDeps["storage"],
  params: Record<string, unknown>,
  chatNativeId: string,
): Promise<ChatRef> {
  const explicitAccount = extractTargetAccount(params);
  if (explicitAccount != null) {
    rejectAccountLabel(explicitAccount);
    return {
      comm: DISCORD_COMM_ID,
      account: explicitAccount as ChatRef["account"],
      chat_native_id: chatNativeId,
    };
  }

  const session = typeof params.session === "string"
    ? await storage.getSession(params.session as SessionId)
    : null;
  const scoped = session
    ? await storage.listAccountRegistrations({
        project: session.project,
        comm: DISCORD_COMM_ID,
        agent: session.agent,
      })
    : [];
  const registration = scoped[0] ?? (
    await storage.listAccountRegistrations({ comm: DISCORD_COMM_ID })
  )[0];
  if (!registration) {
    throw new Error("no Discord account registration exists; run agents-comm account-add first");
  }
  return {
    comm: DISCORD_COMM_ID,
    account: registration.bot_user_id as ChatRef["account"],
    chat_native_id: chatNativeId,
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

function rejectAccountLabel(account: string): void {
  if (!/^\d+$/.test(account)) {
    throw new Error(
      `target.account "${account}" is not a registered bot id — labels like "main" are not accepted; ` +
        `use the concrete bot_user_id from account-add or list_conversations`,
    );
  }
}

async function readJsonDiscordConfig(
  filePath: string,
): Promise<{ botToken?: string; applicationId?: string; botUserId?: string } | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const botToken = typeof parsed.bot_token === "string" ? parsed.bot_token : undefined;
    const applicationId =
      typeof parsed.application_id === "string" ? parsed.application_id : undefined;
    const botUserId = typeof parsed.bot_user_id === "string" ? parsed.bot_user_id : undefined;
    if (!botToken && !applicationId && !botUserId) {
      return undefined;
    }
    return { botToken, applicationId, botUserId };
  } catch {
    return undefined;
  }
}
