/**
 * Curl comm adapter factory (AGE-50).
 *
 * Credential resolution follows the daemon-owned `file:` token-ref pattern:
 * `account-add --comm curl --bot-token <secret>` writes `{ "botToken": ... }`
 * into the daemon state root and stores the file ref on the registration. The
 * token file may optionally carry a fixed `"port"`; otherwise the adapter
 * binds an ephemeral loopback port and publishes it via
 * `<stateRoot>/curl/<account>/endpoint.json`.
 *
 * Identity is synthetic — there is no remote bot API to probe. The default
 * account id is `curl:local`; an explicit id (for multi-scope setups) comes
 * through `account-add --account-id`.
 */
import type {
  AccountId,
  AccountRegistration,
  CommAdapter,
  CommId,
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
import { CurlCommAdapter } from "./adapter.js";

const CURL_COMM_ID = "curl" as CommId;

export const DEFAULT_CURL_ACCOUNT_ID = "curl:local";

export class CurlCommAdapterFactory implements CommAdapterFactory {
  readonly commId = CURL_COMM_ID;

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

    const parsed = fileResult.json as Record<string, unknown>;
    const token = typeof parsed.botToken === "string" && parsed.botToken.trim().length > 0
      ? parsed.botToken
      : typeof parsed.token === "string" && parsed.token.trim().length > 0
        ? parsed.token
        : undefined;
    if (!token) {
      return {
        status: "invalid",
        failureKind: "missing_field",
        reason: "missing required field: token",
        path: fileResult.path,
      };
    }
    const port = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0
      ? parsed.port
      : undefined;

    const envAllowed = normalizeCsv(env.CURL_SENDER_ID);
    const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
    const userId = normalizeUserIdField(parsed.userId);

    return {
      status: "ok",
      credentials: {
        token,
        port,
        project: registration.project,
        agent: registration.agent,
        allowedSenderIds: mergeAllowed(envAllowed, userId.length > 0 ? userId : undefined, dbAllowed),
      },
    };
  }

  async probeIdentity(
    credentials: Record<string, unknown>,
  ): Promise<{ accountId: AccountId; accountUsername?: string | null }> {
    const token = typeof credentials.botToken === "string" ? credentials.botToken : null;
    if (!token || token.trim().length === 0) {
      throw new Error("CurlCommAdapterFactory.probeIdentity: credentials.botToken is required");
    }
    const explicit = typeof credentials.accountId === "string" ? credentials.accountId.trim() : "";
    if (explicit && /\s/.test(explicit)) {
      throw new Error(
        `CurlCommAdapterFactory.probeIdentity: explicit account id "${explicit}" must not contain whitespace`,
      );
    }
    return {
      accountId: (explicit || DEFAULT_CURL_ACCOUNT_ID) as AccountId,
      accountUsername: null,
    };
  }

  create(
    credentials: Record<string, unknown>,
    accountId: AccountId,
    context?: CommAdapterCreateContext,
  ): CommAdapter {
    const token = typeof credentials.token === "string" ? credentials.token : null;
    const project = typeof credentials.project === "string" ? credentials.project : null;
    const agent = typeof credentials.agent === "string" ? credentials.agent : null;
    if (!token || !project || !agent) {
      throw new Error(
        "CurlCommAdapterFactory.create: credentials.token, project, and agent are required",
      );
    }
    const allowed = Array.isArray(credentials.allowedSenderIds)
      ? (credentials.allowedSenderIds as unknown[]).map(String)
      : [];
    return new CurlCommAdapter({
      token,
      accountId,
      project,
      agent,
      port: typeof credentials.port === "number" && Number.isInteger(credentials.port)
        ? credentials.port
        : undefined,
      allowedSenderIds: allowed,
      stateRoot: context?.stateRoot,
    });
  }

  /**
   * Outbound IPC surface exists only to fail loudly: the generic MCP shim
   * maps `comm_send_message` → `curl_send`, and without these handlers a
   * misrouted send dies with a cryptic "unknown method" instead of the
   * inbound-only diagnostic the spec calls for.
   */
  ipcMethods(_deps: CommIpcDeps): Map<string, IpcMethodHandler> {
    const rejectOutbound = (operation: string): IpcMethodHandler => async () => {
      throw new Error(
        `curl comm is local inbound-only (AGE-50 V1): ${operation} is not supported. ` +
          `Inject context by POSTing to the local /messages endpoint; reply over a ` +
          `bidirectional comm (telegram/discord/matrix) instead.`,
      );
    };
    return new Map<string, IpcMethodHandler>([
      ["curl_send", rejectOutbound("outbound send")],
      ["curl_send_image", rejectOutbound("outbound attachments")],
    ]);
  }
}

export function createCommAdapterFactory(): CommAdapterFactory {
  return new CurlCommAdapterFactory();
}

function normalizeUserIdField(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((value) => (typeof value === "string" || typeof value === "number" ? String(value) : ""))
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return [raw.trim()].filter(Boolean);
  if (typeof raw === "number") return [String(raw)];
  return [];
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
    context.storage.listAllowlistGlobal({ comm: CURL_COMM_ID }),
    context.storage.listAllowlistPerBot({ comm: CURL_COMM_ID, bot_user_id }),
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
