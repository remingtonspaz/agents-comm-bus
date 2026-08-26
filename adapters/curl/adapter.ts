/**
 * Curl comm adapter (AGE-50): local POST ingress to agent context.
 *
 * Deliberately dumb V1: inbound only, local only, curl-friendly. A loopback
 * HTTP server accepts `POST /messages` with a bearer token and converts the
 * body into a normal inbound `Message` dispatched through the existing bus
 * path (transcript/audit, pendingInbound, bridge wake trigger, drain into
 * `[Daemon Inbound Messages]`). There is no outbound, no callbacks, no
 * polling — `send()` rejects loudly.
 *
 * Example:
 *   curl -s -X POST "http://127.0.0.1:$(jq -r .port endpoint.json)/messages" \
 *     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 *     -d '{"project":"D:/proj","agent":"claude","sender_id":"ci","text":"build green"}'
 */
import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";

import type {
  AccountId,
  ChatRef,
  CommAdapter,
  CommConnectionState,
  CommId,
  ConversationId,
  FailureClassification,
  FilterDropEvent,
  InboundAcceptance,
  Message,
  MessageId,
  OutboundPayload,
  SendResult,
  Storage,
} from "agents-comm-bus-core";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { attachInboundMessageContext } from "../../core-daemon/runtime/inbound-message-context.js";
import {
  curlReceiptTtlMs,
  curlIdempotencyScopeKey,
  curlRequestHash,
  syntheticChatNativeId,
  validateCurlIdempotencyKey,
  validateCurlMetadata,
} from "./idempotency.js";

// Keep the AGE-50 helper export stable for existing adapter consumers.
export { syntheticChatNativeId } from "./idempotency.js";

export const CURL_LOOPBACK_HOST = "127.0.0.1";
export const CURL_MESSAGES_PATH = "/messages";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface CurlCommAdapterOptions {
  /** Shared secret callers present as `Authorization: Bearer <token>`. */
  token: string;
  /** Synthetic account id this registration is bound to (e.g. `curl:local`). */
  accountId: AccountId;
  /** Registration project this ingress serves; POST bodies must match. */
  project: string;
  /** Registration agent this ingress serves; POST bodies must match. */
  agent: string;
  /** Fixed loopback port; 0/omitted binds an ephemeral port. */
  port?: number;
  allowedSenderIds?: readonly string[];
  /**
   * Daemon state root. When set, the adapter writes
   * `<stateRoot>/curl/<account>/endpoint.json` on start so local scripts can
   * discover the bound port without parsing daemon logs.
   */
  stateRoot?: string;
  now?: () => number;
  log?: (message: string) => void;
  /** AGE-10: verbose allowlist-filter tracing (pass AND drop). */
  filterTrace?: boolean;
  maxBodyBytes?: number;
  /** Immutable registration surrogate for idempotency scoping (AGE-96). */
  registrationId?: string;
  /** Daemon storage for durable curl idempotency receipts (AGE-96). */
  storage?: Storage;
  receiptTtlMs?: number;
}

/** Filesystem-safe folder name for an account id like `curl:local`. */
export function sanitizeAccountIdForPath(accountId: string): string {
  return accountId.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function curlEndpointFilePath(stateRoot: string, accountId: string): string {
  return path.join(stateRoot, "curl", sanitizeAccountIdForPath(accountId), "endpoint.json");
}

interface ParsedCurlPost {
  project: string;
  agent: string;
  sender_id: string;
  text: string;
  chat_native_id?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}

/**
 * Validate a decoded POST body. Returns the parsed shape or a caller-facing
 * error string (HTTP 400) — never throws.
 */
export function parseCurlPostBody(raw: unknown): { body: ParsedCurlPost } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  for (const field of ["project", "agent", "sender_id", "text"] as const) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return { error: `body.${field} is required and must be a non-empty string` };
    }
  }
  if (record.chat_native_id != null && typeof record.chat_native_id !== "string") {
    return { error: "body.chat_native_id must be a string when present" };
  }
  if (
    record.metadata != null &&
    (typeof record.metadata !== "object" || Array.isArray(record.metadata))
  ) {
    return { error: "body.metadata must be a JSON object when present" };
  }
  let metadata: Record<string, unknown> | undefined;
  if (record.metadata != null) {
    const validatedMetadata = validateCurlMetadata(record.metadata);
    if ("error" in validatedMetadata) return validatedMetadata;
    metadata = Object.keys(validatedMetadata.metadata).length > 0
      ? validatedMetadata.metadata
      : undefined;
  }
  let idempotency_key: string | undefined;
  if (record.idempotency_key != null) {
    const validated = validateCurlIdempotencyKey(record.idempotency_key);
    if ("error" in validated) return validated;
    idempotency_key = validated.key;
  }
  return {
    body: {
      project: record.project as string,
      agent: record.agent as string,
      sender_id: (record.sender_id as string).trim(),
      text: record.text as string,
      chat_native_id:
        typeof record.chat_native_id === "string" && record.chat_native_id.length > 0
          ? record.chat_native_id
          : undefined,
      metadata,
      idempotency_key,
    },
  };
}

/** Constant-time bearer-token check over the `Authorization` header. */
export function isAuthorizedCurlRequest(
  authorizationHeader: string | undefined,
  token: string,
): boolean {
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
  if (!match) return false;
  const presented = crypto.createHash("sha256").update(match[1]!).digest();
  const expected = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(presented, expected);
}

export class CurlCommAdapter implements CommAdapter {
  readonly id = "curl" as CommId;
  readonly accountId: AccountId;

  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly filterTrace: boolean;
  private readonly maxBodyBytes: number;
  private readonly normalizedProject: string;
  private allowedSenders: Set<string>;
  private inboundHandler: ((msg: Message) => Promise<void | InboundAcceptance>) | null = null;
  private filterDropHandler: ((event: FilterDropEvent) => void) | null = null;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private connectionState: CommConnectionState | null = null;
  private server: Server | null = null;
  private boundPort: number | null = null;
  private readonly inflightByScope = new Map<string, InflightIdempotentPost>();

  constructor(private readonly options: CurlCommAdapterOptions) {
    if (!options.token) {
      throw new Error("CurlCommAdapter: a non-empty token is required");
    }
    this.accountId = options.accountId;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
    this.filterTrace = options.filterTrace ?? process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1";
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.normalizedProject = normalizeProjectPath(options.project);
    this.allowedSenders = new Set(options.allowedSenderIds ?? []);
  }

  get allowedSenderIds(): readonly string[] {
    return Array.from(this.allowedSenders);
  }

  updateAllowedSenderIds(ids: readonly string[]): void {
    this.allowedSenders = new Set(ids);
  }

  /** Bound loopback port once started (ephemeral binds resolve here). */
  get port(): number | null {
    return this.boundPort;
  }

  /**
   * One live HTTP listener per registration: a second daemon serving the same
   * curl account would race for the port (or silently split discovery files),
   * so the account id is the exclusive single-consumer resource.
   */
  exclusiveResource(): { resourceId: string } | null {
    return { resourceId: String(this.accountId) };
  }

  async start(): Promise<void> {
    this.emitState("connecting");
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        this.respondJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(this.options.port ?? 0, CURL_LOOPBACK_HOST, () => {
        server.removeListener("error", rejectPromise);
        resolvePromise();
      });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    await this.writeEndpointFile();
    this.emitState("connected");
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    await this.removeEndpointFile();
    this.boundPort = null;
    this.emitState("disconnected");
  }

  onInbound(handler: (msg: Message) => Promise<void | InboundAcceptance>): void {
    this.inboundHandler = handler;
  }

  onFilterDrop(handler: (event: FilterDropEvent) => void): void {
    this.filterDropHandler = handler;
  }

  onConnectionState(handler: (state: CommConnectionState) => void): void {
    this.stateHandler = handler;
    if (this.connectionState) {
      handler(this.connectionState);
    }
  }

  /**
   * V1 is inbound-only by spec: there is no caller to deliver outbound to —
   * the HTTP exchange is over by the time an agent replies. Loud diagnostic
   * instead of a silent no-op so a misrouted `bus.send` is debuggable.
   */
  async send(target: ChatRef, _payload: OutboundPayload, _idempotencyKey: string): Promise<SendResult> {
    throw new Error(
      `agents-comm-bus curl[${this.accountId}]: outbound send to ` +
        `chat=${target.chat_native_id} is not supported — the curl adapter is ` +
        `local inbound-only (AGE-50 V1). Reply over a bidirectional comm ` +
        `(e.g. telegram/discord/matrix) instead.`,
    );
  }

  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }

  classifyFailure(): FailureClassification {
    // Every failure this adapter raises (notably unsupported outbound) is
    // structural, not transient — retrying cannot succeed.
    return "permanent";
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", `http://${CURL_LOOPBACK_HOST}`).pathname;
    if (pathname !== CURL_MESSAGES_PATH) {
      this.respondJson(res, 404, { ok: false, error: `unknown path ${pathname}; POST ${CURL_MESSAGES_PATH}` });
      return;
    }
    if (req.method !== "POST") {
      this.respondJson(res, 405, { ok: false, error: `method ${req.method} not allowed; use POST` });
      return;
    }

    if (!isAuthorizedCurlRequest(req.headers.authorization, this.options.token)) {
      this.emitFilterDrop({
        reason: "unauthorized",
        update_kind: "http_post",
        chat_native_id: undefined,
      });
      this.respondJson(res, 401, {
        ok: false,
        error: "unauthorized: present the registration token as 'Authorization: Bearer <token>'",
      });
      return;
    }

    const rawBody = await this.readBody(req);
    if (rawBody === null) {
      this.respondJson(res, 413, { ok: false, error: `body exceeds ${this.maxBodyBytes} bytes` });
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString("utf8"));
    } catch {
      this.respondJson(res, 400, { ok: false, error: "body is not valid JSON" });
      return;
    }
    const parsed = parseCurlPostBody(decoded);
    if ("error" in parsed) {
      this.respondJson(res, 400, { ok: false, error: parsed.error });
      return;
    }
    const body = parsed.body;

    if (
      normalizeProjectPath(body.project) !== this.normalizedProject ||
      body.agent !== this.options.agent
    ) {
      this.respondJson(res, 404, {
        ok: false,
        error:
          `this curl endpoint serves project=${this.normalizedProject}, agent=${this.options.agent} ` +
          `(got project=${body.project}, agent=${body.agent}); ` +
          `register a curl account for that scope and POST to its endpoint`,
      });
      return;
    }

    if (this.allowedSenders.size > 0 && !this.allowedSenders.has(body.sender_id)) {
      this.emitFilterDrop({
        reason: "sender_not_allowed",
        update_kind: "http_post",
        sender_id: body.sender_id,
        chat_native_id: body.chat_native_id ?? syntheticChatNativeId(body.sender_id),
      });
      this.respondJson(res, 403, {
        ok: false,
        error: `sender_id ${body.sender_id} is not in this account's allowlist; fix with 'agents-comm allowlist add'`,
      });
      return;
    }
    this.traceFilterPass(body.sender_id);

    const handler = this.inboundHandler;
    if (!handler) {
      this.respondJson(res, 503, { ok: false, error: "adapter not attached to the bus yet; retry" });
      return;
    }

    if (body.idempotency_key) {
      await this.handleIdempotentPost(res, body, handler);
      return;
    }

    const acceptance = await this.dispatchInbound(body, handler, crypto.randomUUID());
    this.respondAccepted(res, acceptance, body);
  }

  private async handleIdempotentPost(
    res: ServerResponse,
    body: ParsedCurlPost,
    handler: (msg: Message) => Promise<void | InboundAcceptance>,
  ): Promise<void> {
    const storage = this.options.storage;
    const registrationId = this.options.registrationId;
    if (!storage || !registrationId) {
      this.respondJson(res, 503, {
        ok: false,
        error: "idempotency_key requires daemon storage wiring; retry after adapter reload",
      });
      return;
    }

    const scopeKey = curlIdempotencyScopeKey({
      registration_id: registrationId,
      sender_id: body.sender_id,
      client_key: body.idempotency_key!,
    });
    const requestHash = curlRequestHash({
      project: body.project,
      agent: body.agent,
      sender_id: body.sender_id,
      text: body.text,
      chat_native_id: body.chat_native_id,
      metadata: body.metadata,
    });
    const existing = this.inflightByScope.get(scopeKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        this.respondJson(res, 409, {
          ok: false,
          error: "idempotency_key was already used with a different request body",
        });
        return;
      }
      const result = await existing.work;
      this.respondJson(res, result.status, result.payload);
      return;
    }

    const work = this.processIdempotentPost(body, handler, storage, registrationId, requestHash);
    this.inflightByScope.set(scopeKey, { requestHash, work });
    try {
      const result = await work;
      this.respondJson(res, result.status, result.payload);
    } finally {
      this.inflightByScope.delete(scopeKey);
    }
  }

  private async processIdempotentPost(
    body: ParsedCurlPost,
    handler: (msg: Message) => Promise<void | InboundAcceptance>,
    storage: Storage,
    registrationId: string,
    requestHash: string,
  ): Promise<IdempotentPostResult> {
    const now = this.now();
    await storage.deleteExpiredCurlInboundReceipts(now);
    const scope = {
      registration_id: registrationId,
      sender_id: body.sender_id,
      client_key: body.idempotency_key!,
    };
    const ttlMs = this.options.receiptTtlMs ?? curlReceiptTtlMs();
    const reserve = await storage.reserveCurlInboundReceipt({
      ...scope,
      request_hash: requestHash,
      message_id: `curl:${crypto.randomUUID()}` as MessageId,
      reserved_at: now,
      expires_at: now + ttlMs,
    });

    if (reserve.kind === "conflict") {
      return {
        status: 409,
        payload: {
          ok: false,
          error: "idempotency_key was already used with a different request body",
        },
      };
    }

    if (reserve.kind === "replay") {
      return {
        status: 202,
        payload: {
          ok: true,
          message_id: reserve.message_id,
          conversation_id: reserve.conversation_id ?? undefined,
          chat_native_id: body.chat_native_id ?? syntheticChatNativeId(body.sender_id),
        },
      };
    }

    const platformUuid = reserve.message_id.slice("curl:".length);
    const acceptance = await this.dispatchInbound(
      body,
      handler,
      platformUuid,
      reserve.message_id,
      scope,
    );
    const accepted = await storage.acceptCurlInboundReceipt({
      ...scope,
      conversation_id: acceptance.conversation_id as ConversationId,
      accepted_at: this.now(),
    });
    if (!accepted) {
      throw new Error(
        `curl idempotency accept failed: pending receipt missing for ` +
          `${scope.registration_id}/${scope.sender_id}/${scope.client_key}`,
      );
    }
    return {
      status: 202,
      payload: {
        ok: true,
        message_id: reserve.message_id,
        conversation_id: acceptance.conversation_id,
        chat_native_id: acceptance.chat_native_id,
      },
    };
  }

  private async dispatchInbound(
    body: ParsedCurlPost,
    handler: (msg: Message) => Promise<void | InboundAcceptance>,
    platformUuid: string,
    messageId?: MessageId,
    idempotencyScope?: {
      registration_id: string;
      sender_id: string;
      client_key: string;
    },
  ): Promise<{ message_id: MessageId; conversation_id?: string; chat_native_id: string }> {
    const chatNativeId = body.chat_native_id ?? syntheticChatNativeId(body.sender_id);
    let message: Message & { metadata?: Record<string, unknown> } = {
      schema_version: 1,
      message_id: messageId ?? (`curl:${platformUuid}` as MessageId),
      chat: {
        comm: this.id,
        account: this.accountId,
        chat_native_id: chatNativeId,
      },
      sender: {
        id: body.sender_id,
        isBot: false,
        isForeignBot: false,
      },
      origin: { comm: this.id },
      text: body.text,
      platform_message_id: platformUuid,
      hop_count: 0,
      received_at: this.now(),
    };
    if (body.metadata) {
      message.metadata = body.metadata;
    }
    if (idempotencyScope) {
      message = attachInboundMessageContext(message, {
        kind: "curl_idempotency",
        scope: idempotencyScope,
      });
    }

    const acceptance = await handler(message);
    return {
      message_id: message.message_id,
      conversation_id:
        acceptance && typeof acceptance === "object" ? acceptance.conversation_id : undefined,
      chat_native_id: chatNativeId,
    };
  }

  private respondAccepted(
    res: ServerResponse,
    acceptance: { message_id: MessageId; conversation_id?: string; chat_native_id: string },
    body: ParsedCurlPost,
  ): void {
    this.respondJson(res, 202, {
      ok: true,
      message_id: acceptance.message_id,
      conversation_id: acceptance.conversation_id,
      chat_native_id: body.chat_native_id ?? syntheticChatNativeId(body.sender_id),
    });
  }

  private readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          req.removeAllListeners("data");
          req.removeAllListeners("end");
          resolvePromise(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolvePromise(Buffer.concat(chunks)));
      req.on("error", rejectPromise);
    });
  }

  private respondJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(`${body}\n`);
  }

  private async writeEndpointFile(): Promise<void> {
    if (!this.options.stateRoot || this.boundPort === null) return;
    const filePath = curlEndpointFilePath(this.options.stateRoot, String(this.accountId));
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        `${JSON.stringify(
          {
            schema_version: 1,
            comm: this.id,
            account_id: this.accountId,
            project: this.normalizedProject,
            agent: this.options.agent,
            host: CURL_LOOPBACK_HOST,
            port: this.boundPort,
            url: `http://${CURL_LOOPBACK_HOST}:${this.boundPort}${CURL_MESSAGES_PATH}`,
            pid: process.pid,
            started_at: this.now(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } catch (error) {
      // Discovery is a convenience; the adapter itself is healthy without it.
      this.log(
        `agents-comm-bus curl[${this.accountId}]: failed to write endpoint file ${filePath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async removeEndpointFile(): Promise<void> {
    if (!this.options.stateRoot) return;
    const filePath = curlEndpointFilePath(this.options.stateRoot, String(this.accountId));
    try {
      await rm(filePath, { force: true });
    } catch {
      // Best effort; a stale endpoint file is detectable by connection failure.
    }
  }

  private emitState(state: CommConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateHandler?.(state);
  }

  private emitFilterDrop(event: FilterDropEvent): void {
    try {
      this.filterDropHandler?.(event);
    } catch {
      // Observability must never break inbound handling.
    }
    if (this.filterTrace) {
      this.log(
        `agents-comm-bus curl[${this.accountId}] FILTER DROP: ${event.update_kind} ` +
          `sender=${event.sender_id ?? "<none>"} reason=${event.reason} ` +
          `(allowlist size=${this.allowedSenders.size})`,
      );
    }
  }

  private traceFilterPass(senderId: string): void {
    if (!this.filterTrace) return;
    this.log(
      `agents-comm-bus curl[${this.accountId}] filter pass: http_post ` +
        `sender=${senderId} (allowlist size=${this.allowedSenders.size})`,
    );
  }
}

interface IdempotentPostResult {
  status: number;
  payload: Record<string, unknown>;
}

interface InflightIdempotentPost {
  requestHash: string;
  work: Promise<IdempotentPostResult>;
}
