import path from "node:path";

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
import {
  readCredentialFile,
  type CredentialResolution,
} from "../../core-daemon/runtime/credential-resolution.js";
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
  ): Promise<CredentialResolution> {
    const ref = registration.credentials_ref ?? "";
    if (!ref.startsWith("file:")) return { status: "absent" };

    const fileResult = await readCredentialFile(ref);
    if (fileResult.status !== "ok") {
      return fileResult;
    }

    const validated = validateMatrixCredentialJson(fileResult.json, fileResult.path);
    if (validated.status !== "ok") {
      return validated;
    }

    const envAllowed = normalizeCsv(env.MATRIX_USER_ID);
    const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);

    return {
      status: "ok",
      credentials: {
        homeserverUrl: validated.credentials.homeserverUrl,
        accessToken: validated.credentials.accessToken,
        userId: validated.credentials.userId,
        deviceId: validated.credentials.deviceId,
        allowedUserIds: mergeAllowed(
          envAllowed,
          validated.credentials.allowedUserIds,
          dbAllowed,
        ),
        allowedRoomIds: validated.credentials.allowedRoomIds ?? [],
        autoJoinInvites: validated.credentials.autoJoinInvites ?? false,
        encryptedRoomPolicy: validated.credentials.encryptedRoomPolicy ?? "decline",
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

const IMAGE_EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function inferImageMimeFromPath(localPath: string): string {
  const ext = path.extname(localPath).slice(1).toLowerCase();
  return IMAGE_EXTENSION_MIME[ext] ?? "application/octet-stream";
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
              mime: inferImageMimeFromPath(localPath!),
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

function validateMatrixCredentialJson(
  json: unknown,
  path: string,
):
  | Extract<CredentialResolution, { status: "invalid" }>
  | { status: "ok"; credentials: MatrixCredentials } {
  const parsed = json as Record<string, unknown>;
  const homeserverUrl = typeof parsed.homeserverUrl === "string"
    ? normalizeHomeserverUrl(parsed.homeserverUrl)
    : undefined;
  if (!homeserverUrl) {
    return {
      status: "invalid",
      failureKind: "missing_field",
      reason: "missing required field: homeserverUrl",
      path,
    };
  }
  const accessToken = typeof parsed.accessToken === "string"
    ? parsed.accessToken.trim()
    : undefined;
  if (!accessToken) {
    return {
      status: "invalid",
      failureKind: "missing_field",
      reason: "missing required field: accessToken",
      path,
    };
  }
  const userId = typeof parsed.userId === "string" ? parsed.userId.trim() : undefined;
  if (!userId) {
    return {
      status: "invalid",
      failureKind: "missing_field",
      reason: "missing required field: userId",
      path,
    };
  }
  if (!isMatrixMxid(userId)) {
    return {
      status: "invalid",
      failureKind: "validation",
      reason: "userId is not a valid Matrix MXID",
      path,
    };
  }
  const encryptedRoomPolicy = parsed.encryptedRoomPolicy === "decline"
    ? "decline"
    : parsed.encryptedRoomPolicy == null
      ? "decline"
      : undefined;
  if (encryptedRoomPolicy == null) {
    return {
      status: "invalid",
      failureKind: "validation",
      reason: "encryptedRoomPolicy must be \"decline\" when set",
      path,
    };
  }
  return {
    status: "ok",
    credentials: {
      homeserverUrl,
      accessToken,
      userId,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      allowedUserIds: normalizeStringArray(parsed.allowedUserIds),
      allowedRoomIds: normalizeStringArray(parsed.allowedRoomIds),
      autoJoinInvites: parsed.autoJoinInvites === true,
      encryptedRoomPolicy,
    },
  };
}
