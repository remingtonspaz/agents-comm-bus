import { readFile } from "node:fs/promises";

import type {
  AccountId,
  AccountRegistration,
  ChatRef,
  CommAdapter,
  CommId,
  SessionId,
} from "agents-comm-bus-core";

import type {
  CommAdapterFactory,
  CommAdapterCreateContext,
  CommAdapterFactoryEnv,
  CommIpcDeps,
  ResolveCredentialsContext,
} from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
import {
  isMatrixMxid,
  MatrixCommAdapter,
  probeMatrixIdentity,
  uploadFilenameFromLocalPath,
  type MatrixIdentityClient,
} from "./adapter.js";

const MATRIX_COMM_ID = "matrix" as CommId;

export type EncryptedRoomPolicy = "decline";

export interface MatrixCredentials {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
  allowedUserIds: string[];
  allowedRoomIds: string[];
  autoJoinInvites: boolean;
  encryptedRoomPolicy: EncryptedRoomPolicy;
}

export interface MatrixCommAdapterFactoryOptions {
  identityClient?: MatrixIdentityClient;
}

export class MatrixCommAdapterFactory implements CommAdapterFactory {
  readonly commId = MATRIX_COMM_ID;

  constructor(private readonly options: MatrixCommAdapterFactoryOptions = {}) {}

  async resolveCredentials(
    registration: AccountRegistration,
    env: CommAdapterFactoryEnv,
    context?: ResolveCredentialsContext,
  ): Promise<{ credentials: Record<string, unknown> } | undefined> {
    const ref = registration.credentials_ref ?? "";
    if (!ref.startsWith("file:")) return undefined;

    const fromFile = await readJsonMatrixConfig(ref.slice("file:".length));
    if (!fromFile) return undefined;

    const envAllowed = normalizeCsv(env.MATRIX_USER_ID);
    const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);

    return {
      credentials: {
        homeserverUrl: fromFile.homeserverUrl,
        accessToken: fromFile.accessToken,
        userId: fromFile.userId,
        deviceId: fromFile.deviceId,
        allowedUserIds: mergeAllowed(envAllowed, fromFile.allowedUserIds, dbAllowed),
        allowedRoomIds: fromFile.allowedRoomIds ?? [],
        autoJoinInvites: fromFile.autoJoinInvites ?? false,
        encryptedRoomPolicy: fromFile.encryptedRoomPolicy ?? "decline",
      },
    };
  }

  async probeIdentity(
    credentials: Record<string, unknown>,
  ): Promise<{ accountId: AccountId; accountUsername?: string | null }> {
    const parsed = parseResolvedCredentials(credentials);
    const identity = await probeMatrixIdentity(
      parsed.homeserverUrl,
      parsed.accessToken,
      parsed.userId,
      this.options.identityClient,
    );
    return {
      accountId: identity.user_id as AccountId,
      accountUsername: identity.localpart,
    };
  }

  create(
    credentials: Record<string, unknown>,
    accountId: AccountId,
    context?: CommAdapterCreateContext,
  ): CommAdapter {
    const parsed = parseResolvedCredentials(credentials);
    return new MatrixCommAdapter({
      homeserverUrl: parsed.homeserverUrl,
      accessToken: parsed.accessToken,
      userId: parsed.userId,
      accountId,
      deviceId: parsed.deviceId,
      allowedUserIds: parsed.allowedUserIds,
      allowedRoomIds: parsed.allowedRoomIds,
      autoJoinInvites: parsed.autoJoinInvites,
      encryptedRoomPolicy: parsed.encryptedRoomPolicy,
      attachmentBlobStore: context?.blobs,
    });
  }

  ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler> {
    return new Map<string, IpcMethodHandler>([
      [
        "matrix_send",
        async (params: Record<string, unknown>) => sendMatrix(deps, params, false),
      ],
      [
        "matrix_send_image",
        async (params: Record<string, unknown>) => sendMatrix(deps, params, true),
      ],
    ]);
  }
}

export function createCommAdapterFactory(
  options?: MatrixCommAdapterFactoryOptions,
): CommAdapterFactory {
  return new MatrixCommAdapterFactory(options);
}

async function sendMatrix(
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
    comm: MATRIX_COMM_ID,
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
  if (params.room_id != null) return String(params.room_id);
  const target = params.target;
  if (target && typeof target === "object" && "chat_native_id" in target) {
    const value = (target as Record<string, unknown>).chat_native_id;
    if (value != null) return String(value);
  }
  if (target && typeof target === "object" && "room_id" in target) {
    const value = (target as Record<string, unknown>).room_id;
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
      comm: MATRIX_COMM_ID,
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
        comm: MATRIX_COMM_ID,
        agent: session.agent,
      })
    : [];
  const registration = scoped[0] ?? (
    await storage.listAccountRegistrations({ comm: MATRIX_COMM_ID })
  )[0];
  if (!registration) {
    throw new Error("no Matrix account registration exists; run agents-comm account-add first");
  }
  return {
    comm: MATRIX_COMM_ID,
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
  if (!isMatrixMxid(account)) {
    throw new Error(
      `target.account "${account}" is not a Matrix MXID — labels like "main" are not accepted; ` +
        `use the concrete bot_user_id (MXID) from account-add or list_conversations`,
    );
  }
}

function parseResolvedCredentials(credentials: Record<string, unknown>): MatrixCredentials {
  const homeserverUrl = typeof credentials.homeserverUrl === "string"
    ? credentials.homeserverUrl
    : null;
  const accessToken = typeof credentials.accessToken === "string"
    ? credentials.accessToken
    : null;
  const userId = typeof credentials.userId === "string" ? credentials.userId : null;
  if (!homeserverUrl || !accessToken || !userId) {
    throw new Error(
      "MatrixCommAdapterFactory: credentials.homeserverUrl, accessToken, and userId are required",
    );
  }
  return {
    homeserverUrl,
    accessToken,
    userId,
    deviceId: typeof credentials.deviceId === "string" ? credentials.deviceId : undefined,
    allowedUserIds: normalizeStringArray(credentials.allowedUserIds),
    allowedRoomIds: normalizeStringArray(credentials.allowedRoomIds),
    autoJoinInvites: credentials.autoJoinInvites === true,
    encryptedRoomPolicy: credentials.encryptedRoomPolicy === "decline" ? "decline" : "decline",
  };
}

function normalizeHomeserverUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
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
    context.storage.listAllowlistGlobal({ comm: MATRIX_COMM_ID }),
    context.storage.listAllowlistPerBot({ comm: MATRIX_COMM_ID, bot_user_id }),
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

async function readJsonMatrixConfig(
  filePath: string,
): Promise<MatrixCredentials | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const homeserverUrl = typeof parsed.homeserverUrl === "string"
      ? normalizeHomeserverUrl(parsed.homeserverUrl)
      : undefined;
    const accessToken = typeof parsed.accessToken === "string"
      ? parsed.accessToken.trim()
      : undefined;
    const userId = typeof parsed.userId === "string" ? parsed.userId.trim() : undefined;
    if (!homeserverUrl || !accessToken || !userId || !isMatrixMxid(userId)) {
      return undefined;
    }
    const encryptedRoomPolicy = parsed.encryptedRoomPolicy === "decline"
      ? "decline"
      : parsed.encryptedRoomPolicy == null
        ? "decline"
        : undefined;
    if (encryptedRoomPolicy == null) return undefined;
    return {
      homeserverUrl,
      accessToken,
      userId,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      allowedUserIds: normalizeStringArray(parsed.allowedUserIds),
      allowedRoomIds: normalizeStringArray(parsed.allowedRoomIds),
      autoJoinInvites: parsed.autoJoinInvites === true,
      encryptedRoomPolicy,
    };
  } catch {
    return undefined;
  }
}
