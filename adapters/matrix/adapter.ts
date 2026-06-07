import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AccountId,
  Attachment,
  BlobStore,
  ChatRef,
  CommAdapter,
  CommConnectionState,
  CommId,
  FailureClassification,
  FilterDropEvent,
  Message,
  MessageId,
  OutboundPayload,
  SendResult,
} from "agents-comm-bus-core";

import { htmlToMatrixFormatted } from "./html.js";
import {
  createFetchMatrixMediaClient,
  matrixOutboundMsgtypeForMime,
  MATRIX_MEDIA_MSGTYPES,
  parseMxcUri,
  type MatrixMediaClient,
} from "./media.js";

export interface MatrixWhoamiResponse {
  user_id: string;
  device_id?: string;
  is_guest?: boolean;
}

export interface MatrixIdentityClient {
  whoami(homeserverUrl: string, accessToken: string): Promise<MatrixWhoamiResponse>;
}

export interface MatrixEventContent {
  msgtype?: string;
  body?: string;
  url?: string;
  format?: string;
  formatted_body?: string;
  info?: {
    mimetype?: string;
    size?: number;
    [key: string]: unknown;
  };
  "m.relates_to"?: {
    "m.in_reply_to"?: {
      event_id?: string;
    };
  };
  [key: string]: unknown;
}

export interface MatrixEvent {
  type?: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: MatrixEventContent;
}

export interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<string, {
      timeline?: { events?: MatrixEvent[] };
      state?: { events?: MatrixEvent[] };
    }>;
    invite?: Record<string, unknown>;
  };
}

export interface MatrixSyncHandlers {
  onSyncResponse(response: MatrixSyncResponse, context?: MatrixSyncContext): Promise<void>;
  onError(error: unknown): void;
}

export interface MatrixSyncContext {
  /** True for the first catch-up response before the client has a since cursor. */
  isInitialSync: boolean;
}

export interface MatrixSyncClient {
  start(handlers: MatrixSyncHandlers): Promise<void>;
  stop(): Promise<void>;
}

export interface MatrixSendMessageRequest {
  roomId: string;
  txnId: string;
  content: MatrixEventContent;
}

export interface MatrixSendMessageResponse {
  event_id: string;
}

export interface MatrixSendClient {
  sendMessage(request: MatrixSendMessageRequest): Promise<MatrixSendMessageResponse>;
}

export interface FetchMatrixSendClientOptions {
  fetchFn?: typeof fetch;
}

export interface MatrixErrorBody {
  errcode?: string;
  error?: string;
  retry_after_ms?: number;
}

export interface FetchMatrixSyncClientOptions {
  /** Matrix /sync long-poll timeout in milliseconds (query param). */
  timeoutMs?: number;
  /** Backoff after retryable loop errors before the next /sync attempt. */
  retryDelayMs?: number;
  fetchFn?: typeof fetch;
}

export interface MatrixCommAdapterOptions {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  accountId: AccountId;
  deviceId?: string;
  allowedUserIds?: readonly string[];
  allowedRoomIds?: readonly string[];
  autoJoinInvites?: boolean;
  encryptedRoomPolicy?: "decline";
  syncClient?: MatrixSyncClient;
  sendClient?: MatrixSendClient;
  mediaClient?: MatrixMediaClient;
  attachmentBlobStore?: BlobStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const DEFAULT_SYNC_RETRY_DELAY_MS = 1_000;
const IDEMPOTENCY_CACHE_MAX = 256;

export function createFetchMatrixSyncClient(
  homeserverUrl: string,
  accessToken: string,
  options: FetchMatrixSyncClientOptions = {},
): MatrixSyncClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_SYNC_RETRY_DELAY_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = homeserverUrl.replace(/\/+$/, "");

  let stopped = false;
  let loopPromise: Promise<void> | null = null;
  let abortController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryResolve: (() => void) | null = null;
  let nextBatch: string | undefined;

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    retryResolve = resolve;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryResolve = null;
      resolve();
    }, ms);
  });

  const cancelRetrySleep = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const resolve = retryResolve;
    retryResolve = null;
    resolve?.();
  };

  const fetchSync = async (): Promise<{ response: MatrixSyncResponse; isInitialSync: boolean }> => {
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const timeout = setTimeout(() => abortController?.abort(), timeoutMs + 5_000);
    const isInitialSync = nextBatch == null;

    try {
      const url = new URL(`${baseUrl}/_matrix/client/v3/sync`);
      url.searchParams.set("timeout", String(timeoutMs));
      if (nextBatch) {
        url.searchParams.set("since", nextBatch);
      }

      const response = await fetchFn(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(
          `Matrix sync failed: HTTP ${response.status}${body ? ` ${body}` : ""}`,
        );
        Object.assign(error, { status: response.status });
        throw error;
      }

      return {
        response: await response.json() as MatrixSyncResponse,
        isInitialSync,
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  const runLoop = async (handlers: MatrixSyncHandlers): Promise<void> => {
    while (!stopped) {
      try {
        const { response, isInitialSync } = await fetchSync();
        if (stopped) break;
        if (response.next_batch) {
          nextBatch = response.next_batch;
        }
        await handlers.onSyncResponse(response, { isInitialSync });
      } catch (error) {
        if (stopped) break;
        handlers.onError(error);
        await sleep(retryDelayMs);
      }
    }
  };

  return {
    async start(handlers: MatrixSyncHandlers): Promise<void> {
      if (loopPromise) return;
      stopped = false;
      loopPromise = runLoop(handlers);
    },

    async stop(): Promise<void> {
      stopped = true;
      abortController?.abort();
      cancelRetrySleep();
      if (loopPromise) {
        await loopPromise.catch(() => {});
        loopPromise = null;
      }
      abortController = null;
    },
  };
}

export function matrixTxnIdFromIdempotencyKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

export function matrixReplyEventId(replyTo: MessageId | undefined): string | undefined {
  if (!replyTo) return undefined;
  return replyTo.startsWith("matrix:") ? replyTo.slice("matrix:".length) : replyTo;
}

export function matrixOutboundMessageContent(payload: OutboundPayload): MatrixEventContent {
  const content: MatrixEventContent = payload.format === "html"
    ? (() => {
        const formatted = htmlToMatrixFormatted(payload.text ?? "");
        return {
          msgtype: "m.text",
          format: "org.matrix.custom.html",
          formatted_body: formatted.formatted_body,
          body: formatted.body,
        };
      })()
    : {
        msgtype: "m.text",
        body: payload.text ?? "",
      };
  const replyEventId = matrixReplyEventId(payload.reply_to);
  if (replyEventId) {
    content["m.relates_to"] = {
      "m.in_reply_to": { event_id: replyEventId },
    };
  }
  return content;
}

/**
 * Matrix upload names must not leak caller local paths to room recipients.
 */
export function uploadFilenameFromLocalPath(localPath: string): string {
  const name = path.win32.basename(localPath);
  if (name && name !== "." && name !== "..") return name;
  const posixName = path.posix.basename(localPath);
  return posixName && posixName !== "." && posixName !== ".." ? posixName : "attachment";
}

export function matrixAttachmentTxnSuffix(
  idempotencyKey: string,
  index: number,
): string {
  return `${matrixTxnIdFromIdempotencyKey(idempotencyKey)}-att-${index}`;
}

export function createFetchMatrixSendClient(
  homeserverUrl: string,
  accessToken: string,
  options: FetchMatrixSendClientOptions = {},
): MatrixSendClient {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = homeserverUrl.replace(/\/+$/, "");

  return {
    async sendMessage(request: MatrixSendMessageRequest): Promise<MatrixSendMessageResponse> {
      const roomId = encodeURIComponent(request.roomId);
      const txnId = encodeURIComponent(request.txnId);
      const url = `${baseUrl}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${txnId}`;
      const response = await fetchFn(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.content),
      });

      const bodyText = await response.text().catch(() => "");
      if (!response.ok) {
        throw matrixSendHttpError(response.status, bodyText);
      }

      const body = bodyText ? JSON.parse(bodyText) as { event_id?: string } : {};
      if (!body.event_id) {
        throw new Error("Matrix send succeeded but response omitted event_id");
      }
      return { event_id: body.event_id };
    },
  };
}

function matrixSendHttpError(status: number, bodyText: string): Error {
  let body: MatrixErrorBody = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as MatrixErrorBody;
    } catch {
      // Keep the raw body in the message below.
    }
  }
  const error = new Error(
    `Matrix send failed: HTTP ${status}${bodyText ? ` ${bodyText}` : ""}`,
  );
  Object.assign(error, {
    status,
    errcode: body.errcode,
    retry_after_ms: body.retry_after_ms,
  });
  return error;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

export class MatrixCommAdapter implements CommAdapter {
  readonly id = "matrix" as CommId;
  readonly accountId: AccountId;

  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly userId: string;
  private readonly syncClient: MatrixSyncClient;
  private readonly sendClient: MatrixSendClient;
  private readonly mediaClient: MatrixMediaClient;
  private readonly attachmentBlobStore?: BlobStore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly sentByKey = new Map<string, SendResult>();
  private allowedUserIds: Set<string>;
  private allowedRoomIds: Set<string>;
  private inboundHandler: ((msg: Message) => Promise<void>) | null = null;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private filterDropHandler: ((event: FilterDropEvent) => void) | null = null;
  private connectionState: CommConnectionState | null = null;
  private started = false;
  private rateLimited = false;

  constructor(private readonly options: MatrixCommAdapterOptions) {
    this.accountId = options.accountId;
    this.homeserverUrl = options.homeserverUrl;
    this.accessToken = options.accessToken;
    this.userId = options.userId;
    this.syncClient = options.syncClient ?? createFetchMatrixSyncClient(
      options.homeserverUrl,
      options.accessToken,
    );
    this.sendClient = options.sendClient ?? createFetchMatrixSendClient(
      options.homeserverUrl,
      options.accessToken,
    );
    this.mediaClient = options.mediaClient ?? createFetchMatrixMediaClient(
      options.homeserverUrl,
      options.accessToken,
    );
    this.attachmentBlobStore = options.attachmentBlobStore;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
    this.allowedRoomIds = new Set(options.allowedRoomIds ?? []);
  }

  get allowedSenderIds(): readonly string[] {
    return Array.from(this.allowedUserIds);
  }

  updateAllowedSenderIds(ids: readonly string[]): void {
    this.allowedUserIds = new Set(ids);
  }

  exclusiveResource(): { resourceId: string } | null {
    return { resourceId: String(this.accountId) };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.emitState("connecting");
    try {
      await this.syncClient.start({
        onSyncResponse: async (response, context) => {
          try {
            await this.processSyncResponse(response, context?.isInitialSync ?? false);
            this.emitState("connected");
          } catch {
            this.emitState("degraded");
          }
        },
        onError: () => {
          this.emitState("degraded");
        },
      });
      this.started = true;
      this.emitState("connected");
    } catch {
      await this.syncClient.stop().catch(() => {});
      this.emitState("disconnected");
      throw new Error("Matrix sync client failed to start");
    }
  }

  async stop(): Promise<void> {
    if (!this.started && this.connectionState === "disconnected") return;
    if (this.started) {
      await this.syncClient.stop().catch(() => {});
    }
    this.started = false;
    this.rateLimited = false;
    this.emitState("disconnected");
  }

  onInbound(handler: (msg: Message) => Promise<void>): void {
    this.inboundHandler = handler;
  }

  onConnectionState(handler: (state: CommConnectionState) => void): void {
    this.stateHandler = handler;
    if (this.connectionState) {
      handler(this.connectionState);
    }
  }

  onFilterDrop(handler: (event: FilterDropEvent) => void): void {
    this.filterDropHandler = handler;
  }

  async send(
    target: ChatRef,
    payload: OutboundPayload,
    idempotencyKey: string,
  ): Promise<SendResult> {
    const cached = this.sentByKey.get(idempotencyKey);
    if (cached) return cached;

    const uploadable = (payload.attachments ?? []).filter((attachment) => attachment.local_path);
    let lastResult: SendResult | null = null;

    if (payload.text) {
      lastResult = await this.sendMessageWithRetry(
        target,
        matrixOutboundMessageContent(payload),
        matrixTxnIdFromIdempotencyKey(idempotencyKey),
      );
    }

    for (let index = 0; index < uploadable.length; index++) {
      const attachment = uploadable[index]!;
      const mediaContent = await this.buildOutboundMediaContent(attachment, payload.reply_to);
      const txnId = uploadable.length > 1 || payload.text
        ? matrixAttachmentTxnSuffix(idempotencyKey, index)
        : matrixTxnIdFromIdempotencyKey(idempotencyKey);
      lastResult = await this.sendMessageWithRetry(target, mediaContent, txnId);
    }

    if (!lastResult) {
      lastResult = await this.sendMessageWithRetry(
        target,
        matrixOutboundMessageContent(payload),
        matrixTxnIdFromIdempotencyKey(idempotencyKey),
      );
    }

    this.rememberSent(idempotencyKey, lastResult);
    return lastResult;
  }

  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: this.rateLimited };
  }

  classifyFailure(error: unknown): FailureClassification {
    const anyError = error as {
      message?: string;
      status?: number;
      statusCode?: number;
      errcode?: string;
      response?: { status?: number; statusCode?: number; body?: { errcode?: string } };
    };
    const message = anyError?.message ?? String(error);
    const status =
      anyError?.status
      ?? anyError?.statusCode
      ?? anyError?.response?.status
      ?? anyError?.response?.statusCode;
    const errcode = anyError?.errcode ?? anyError?.response?.body?.errcode;

    if (
      status === 401
      || status === 403
      || /\b401\b|\b403\b|unauthorized|forbidden/i.test(message)
    ) {
      return "permanent";
    }
    if (
      status === 429
      || errcode === "M_LIMIT_EXCEEDED"
      || errcode === "M_USER_LIMIT_EXCEEDED"
      || /rate.?limit|too many requests|M_LIMIT_EXCEEDED|M_USER_LIMIT_EXCEEDED/i.test(message)
    ) {
      return "rate_limited";
    }
    if ((status != null && status >= 500) || /ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(message)) {
      return "transient";
    }
    return "transient";
  }

  private async processSyncResponse(
    response: MatrixSyncResponse,
    isInitialSync: boolean,
  ): Promise<void> {
    // The first Matrix /sync response without a since cursor is history catch-up.
    // Delivering it as fresh inbound would replay recent room history on every daemon restart.
    if (isInitialSync) return;

    const joined = response.rooms?.join;
    if (!joined) return;

    for (const [roomId, roomData] of Object.entries(joined)) {
      const events = roomData.timeline?.events ?? [];
      for (const event of events) {
        await this.handleTimelineEvent(roomId, event);
      }
    }
  }

  private async handleTimelineEvent(roomId: string, event: MatrixEvent): Promise<void> {
    if (!this.inboundHandler) return;

    if (event.type === "m.room.encrypted") return;
    if (event.type !== "m.room.message") return;

    const content = event.content;
    if (!content || typeof content !== "object") return;

    const msgtype = content.msgtype;
    const isText = msgtype === "m.text" || msgtype === "m.notice";
    const isMedia = typeof msgtype === "string" && MATRIX_MEDIA_MSGTYPES.has(msgtype);
    if (!isText && !isMedia) return;

    const eventId = event.event_id;
    const sender = event.sender;
    if (!eventId) return;

    if (!sender) {
      this.emitFilterDrop({
        reason: "missing_sender_id",
        update_kind: "message",
        chat_native_id: roomId,
        platform_message_id: eventId,
      });
      return;
    }

    if (sender === this.accountId) return;

    if (this.allowedRoomIds.size > 0 && !this.allowedRoomIds.has(roomId)) {
      this.emitFilterDrop({
        reason: "sender_not_allowed",
        update_kind: "message",
        sender_id: sender,
        chat_native_id: roomId,
        platform_message_id: eventId,
      });
      return;
    }

    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(sender)) {
      this.emitFilterDrop({
        reason: "sender_not_allowed",
        update_kind: "message",
        sender_id: sender,
        chat_native_id: roomId,
        platform_message_id: eventId,
      });
      return;
    }

    const body = typeof content.body === "string" ? content.body : "";
    if (isText && !body) return;

    const replyTo = matrixReplyToMessageId(content);
    const attachments = isMedia
      ? [await this.buildInboundMediaAttachment(content, msgtype!)]
      : [];

    await this.inboundHandler({
      schema_version: 1,
      message_id: `matrix:${eventId}` as MessageId,
      chat: {
        comm: this.id,
        account: this.accountId,
        chat_native_id: roomId,
      },
      sender: {
        id: sender,
        display_name: sender,
        isBot: false,
        isForeignBot: false,
      },
      origin: { comm: this.id },
      text: body,
      attachments,
      platform_message_id: eventId,
      reply_to: replyTo,
      hop_count: 0,
      received_at: typeof event.origin_server_ts === "number"
        ? event.origin_server_ts
        : this.now(),
    });
  }

  private async buildInboundMediaAttachment(
    content: MatrixEventContent,
    msgtype: string,
  ): Promise<Attachment> {
    const info = content.info && typeof content.info === "object" ? content.info : {};
    const mxcUri = typeof content.url === "string" ? content.url : "";
    const body = typeof content.body === "string" ? content.body : "";
    const infoName = typeof info.name === "string" ? info.name : undefined;
    const filename = body || infoName || "attachment";
    const mime = typeof info.mimetype === "string" ? info.mimetype : "application/octet-stream";
    const size = typeof info.size === "number" ? info.size : 0;
    const base: Attachment = {
      mime,
      filename,
      size,
      platform_metadata: {
        mxc_uri: mxcUri || undefined,
        msgtype,
        info,
      },
    };

    if (!mxcUri || !parseMxcUri(mxcUri) || !this.attachmentBlobStore) {
      return base;
    }

    try {
      const downloaded = await this.mediaClient.download(mxcUri);
      const ref = await this.attachmentBlobStore.put(
        downloaded.content,
        downloaded.mime ?? mime,
      );
      return {
        ...base,
        mime: downloaded.mime ?? mime,
        size: size > 0 ? size : ref.size,
        blob_hash: ref.hash,
        local_path: this.attachmentBlobStore.pathFor(ref),
        platform_metadata: {
          ...base.platform_metadata,
          retrieved_at: this.now(),
        },
      };
    } catch (error) {
      return {
        ...base,
        platform_metadata: {
          ...base.platform_metadata,
          retrieval_error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async buildOutboundMediaContent(
    attachment: Attachment,
    replyTo: MessageId | undefined,
  ): Promise<MatrixEventContent> {
    const localPath = attachment.local_path!;
    const bytes = await readFile(localPath);
    const mime = attachment.mime || "application/octet-stream";
    const filename = attachment.filename || uploadFilenameFromLocalPath(localPath);
    const mxcUri = await this.mediaClient.upload({
      content: bytes,
      mime,
      filename,
    });
    const content: MatrixEventContent = {
      msgtype: matrixOutboundMsgtypeForMime(mime),
      body: filename,
      url: mxcUri,
      info: {
        mimetype: mime,
        size: attachment.size > 0 ? attachment.size : bytes.byteLength,
      },
    };
    const replyEventId = matrixReplyEventId(replyTo);
    if (replyEventId) {
      content["m.relates_to"] = {
        "m.in_reply_to": { event_id: replyEventId },
      };
    }
    return content;
  }

  private async sendMessageWithRetry(
    target: ChatRef,
    content: MatrixEventContent,
    txnId: string,
  ): Promise<SendResult> {
    let retried429 = false;

    while (true) {
      try {
        const response = await this.sendClient.sendMessage({
          roomId: target.chat_native_id,
          txnId,
          content,
        });
        const result = {
          platform_message_id: response.event_id,
          sent_at: this.now(),
        };
        this.rateLimited = false;
        this.emitState("connected");
        return result;
      } catch (error) {
        if (!retried429 && this.classifyFailure(error) === "rate_limited") {
          const retryAfterMs = (error as { retry_after_ms?: number }).retry_after_ms;
          if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
            retried429 = true;
            this.rateLimited = true;
            if (retryAfterMs > 0) {
              await this.sleep(retryAfterMs);
            }
            continue;
          }
          this.rateLimited = true;
          throw error;
        }
        throw error;
      }
    }
  }

  private rememberSent(idempotencyKey: string, result: SendResult): void {
    if (this.sentByKey.size >= IDEMPOTENCY_CACHE_MAX) {
      const oldest = this.sentByKey.keys().next().value;
      if (oldest !== undefined) {
        this.sentByKey.delete(oldest);
      }
    }
    this.sentByKey.set(idempotencyKey, result);
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
  }
}

function matrixReplyToMessageId(content: MatrixEventContent): MessageId | undefined {
  const relatesTo = content["m.relates_to"];
  if (!relatesTo || typeof relatesTo !== "object") return undefined;
  const inReplyTo = relatesTo["m.in_reply_to"];
  if (!inReplyTo || typeof inReplyTo !== "object") return undefined;
  const eventId = inReplyTo.event_id;
  if (typeof eventId !== "string" || !eventId) return undefined;
  return `matrix:${eventId}` as MessageId;
}

export function mxidLocalpart(userId: string): string | null {
  const match = /^@([^:]+):/.exec(userId);
  return match ? match[1] : null;
}

export function isMatrixMxid(value: string): boolean {
  return /^@[^:]+:[^:]+$/.test(value);
}

const defaultIdentityClient: MatrixIdentityClient = {
  async whoami(homeserverUrl, accessToken) {
    const response = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(
        `Matrix whoami failed: HTTP ${response.status}${body ? ` ${body}` : ""}`,
      );
      Object.assign(error, { status: response.status });
      throw error;
    }
    return await response.json() as MatrixWhoamiResponse;
  },
};

export async function probeMatrixIdentity(
  homeserverUrl: string,
  accessToken: string,
  expectedUserId: string,
  client: MatrixIdentityClient = defaultIdentityClient,
): Promise<{ user_id: string; localpart: string | null }> {
  const whoami = await client.whoami(homeserverUrl, accessToken);
  if (whoami.is_guest) {
    throw new Error("Matrix guest accounts are not supported");
  }
  if (whoami.user_id !== expectedUserId) {
    throw new Error(
      `Matrix whoami user_id mismatch: expected ${expectedUserId}, got ${whoami.user_id}`,
    );
  }
  return { user_id: whoami.user_id, localpart: mxidLocalpart(whoami.user_id) };
}
