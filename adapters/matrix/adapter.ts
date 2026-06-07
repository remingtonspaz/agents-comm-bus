import type {
  AccountId,
  ChatRef,
  CommAdapter,
  CommConnectionState,
  CommId,
  FailureClassification,
  FilterDropEvent,
  Message,
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
}

export class MatrixCommAdapter implements CommAdapter {
  readonly id = "matrix" as CommId;
  readonly accountId: AccountId;

  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly userId: string;
  private allowedUserIds: Set<string>;
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
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
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
    this.started = true;
    this.emitState("connecting");
    this.emitState("connected");
  }

  async stop(): Promise<void> {
    if (!this.started && this.connectionState === "disconnected") return;
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

  private emitState(state: CommConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateHandler?.(state);
  }
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
