/**
 * Discord comm adapter factory + IPC method surface.
 */
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
import {
  readCredentialFile,
  type CredentialResolution,
} from "../../core-daemon/runtime/credential-resolution.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
import { DiscordCommAdapter, probeDiscordIdentity, uploadFilenameFromLocalPath } from "./adapter.js";

const DISCORD_COMM_ID = "discord" as CommId;

export interface DiscordCredentials {
  botToken: string;
  allowedUserIds: string[];
  applicationId?: string;
}

export class DiscordCommAdapterFactory implements CommAdapterFactory {
  readonly commId = DISCORD_COMM_ID;

  async resolveCredentials(
    registration: AccountRegistration,
    env: CommAdapterFactoryEnv,
    context?: ResolveCredentialsContext,
  ): Promise<CredentialResolution> {
    const ref = registration.credentials_ref ?? "";
    if (!ref.startsWith("file:")) {
      return { status: "absent" };
    }

    const fileResult = await readCredentialFile(ref);
    if (fileResult.status !== "ok") {
      return fileResult;
    }

    const parsed = fileResult.json as { botToken?: unknown; bot_token?: unknown; userId?: unknown };
    const botToken = typeof parsed.botToken === "string"
      ? parsed.botToken
      : typeof parsed.bot_token === "string"
        ? parsed.bot_token
        : undefined;
    if (!botToken) {
      return {
        status: "invalid",
        failureKind: "missing_field",
        reason: "missing required field: botToken",
        path: fileResult.path,
      };
    }

    const envAllowed = normalizeCsv(env.DISCORD_USER_ID);
    const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
    const userId = normalizeUserIdField(parsed.userId);
    return {
      status: "ok",
      credentials: {
        botToken,
        allowedUserIds: mergeAllowed(envAllowed, userId.length > 0 ? userId : undefined, dbAllowed),
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
    context?: CommAdapterCreateContext,
  ): CommAdapter {
    const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
    if (!botToken) {
      throw new Error("DiscordCommAdapterFactory.create: credentials.botToken is required");
    }
    const applicationId =
      typeof credentials.applicationId === "string" ? credentials.applicationId : undefined;
    const allowed = Array.isArray(credentials.allowedUserIds)
      ? (credentials.allowedUserIds as string[]).map(String)
      : [];
    return new DiscordCommAdapter({
      botToken,
      applicationId,
      accountId,
      allowedUserIds: allowed,
      attachmentBlobStore: context?.blobs,
    });
  }

  ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler> {
    return new Map<string, IpcMethodHandler>([
      [
        "discord_send",
        async (params: Record<string, unknown>) => sendDiscord(deps, params, false),
      ],
      [
        "discord_send_image",
        async (params: Record<string, unknown>) => sendDiscord(deps, params, true),
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
  image: boolean,
): Promise<{ message_id: string }> {
  const chatNativeId = extractChatNativeId(params);
  const target = chatNativeId === null
    ? undefined
    : await targetFromParams(deps.storage, params, chatNativeId);
  const localPath = image ? String(params.path) : null;
  const sent = await deps.bus.send({
    session: String(params.session ?? "mcp") as SessionId,
    comm: DISCORD_COMM_ID,
    target,
    payload: image
      ? {
          text: typeof params.caption === "string" ? params.caption : undefined,
          attachments: [
            {
              filename: uploadFilenameFromLocalPath(localPath!),
              local_path: localPath!,
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
    context.storage.listAllowlistGlobal({ comm: DISCORD_COMM_ID }),
    context.storage.listAllowlistPerBot({ comm: DISCORD_COMM_ID, bot_user_id }),
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
