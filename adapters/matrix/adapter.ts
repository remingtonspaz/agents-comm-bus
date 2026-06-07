import type {
  AccountId,
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
  onSyncResponse(response: MatrixSyncResponse): Promise<void>;
  onError(error: unknown): void;
}

export interface MatrixSyncClient {
  start(handlers: MatrixSyncHandlers): Promise<void>;
  stop(): Promise<void>;
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
  now?: () => number;
}

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const DEFAULT_SYNC_RETRY_DELAY_MS = 1_000;

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

  const fetchSync = async (): Promise<MatrixSyncResponse> => {
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const timeout = setTimeout(() => abortController?.abort(), timeoutMs + 5_000);

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

      return await response.json() as MatrixSyncResponse;
    } finally {
      clearTimeout(timeout);
    }
  };

  const runLoop = async (handlers: MatrixSyncHandlers): Promise<void> => {
    while (!stopped) {
      try {
        const response = await fetchSync();
        if (stopped) break;
        if (response.next_batch) {
          nextBatch = response.next_batch;
        }
        await handlers.onSyncResponse(response);
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

export class MatrixCommAdapter implements CommAdapter {
  readonly id = "matrix" as CommId;
  readonly accountId: AccountId;

  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly userId: string;
  private readonly syncClient: MatrixSyncClient;
  private readonly now: () => number;
  private allowedUserIds: Set<string>;
  private allowedRoomIds: Set<string>;
  private inboundHandler: ((msg: Message) => Promise<void>) | null = null;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private filterDropHandler: ((event: FilterDropEvent) => void) | null = null;
  private connectionState: CommConnectionState | null = null;
  private started = false;

  constructor(private readonly options: MatrixCommAdapterOptions) {
    this.accountId = options.accountId;
    this.homeserverUrl = options.homeserverUrl;
    this.accessToken = options.accessToken;
    this.userId = options.userId;
    this.syncClient = options.syncClient ?? createFetchMatrixSyncClient(
      options.homeserverUrl,
      options.accessToken,
    );
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
        onSyncResponse: async (response) => {
          try {
            await this.processSyncResponse(response);
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
    _target: ChatRef,
    _payload: OutboundPayload,
    _idempotencyKey: string,
  ): Promise<SendResult> {
    const error = new Error("Matrix outbound send is not implemented (P1 skeleton)");
    Object.assign(error, { status: 501 });
    throw error;
  }

  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
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
    if (status === 501 || /not implemented/i.test(message)) {
      return "permanent";
    }
    if ((status != null && status >= 500) || /ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(message)) {
      return "transient";
    }
    return "transient";
  }

  private async processSyncResponse(response: MatrixSyncResponse): Promise<void> {
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
    if (msgtype !== "m.text" && msgtype !== "m.notice") return;

    const eventId = event.event_id;
    const sender = event.sender;
    const body = typeof content.body === "string" ? content.body : null;
    if (!eventId || !body) return;

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

    const replyTo = matrixReplyToMessageId(content);

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
      attachments: [],
      platform_message_id: eventId,
      reply_to: replyTo,
      hop_count: 0,
      received_at: typeof event.origin_server_ts === "number"
        ? event.origin_server_ts
        : this.now(),
    });
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
