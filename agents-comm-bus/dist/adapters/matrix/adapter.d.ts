import type { AccountId, ChatRef, CommAdapter, CommConnectionState, CommId, FailureClassification, FilterDropEvent, Message, MessageId, OutboundPayload, SendResult } from "agents-comm-bus-core";
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
            timeline?: {
                events?: MatrixEvent[];
            };
            state?: {
                events?: MatrixEvent[];
            };
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
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}
export declare function createFetchMatrixSyncClient(homeserverUrl: string, accessToken: string, options?: FetchMatrixSyncClientOptions): MatrixSyncClient;
export declare function matrixTxnIdFromIdempotencyKey(idempotencyKey: string): string;
export declare function matrixReplyEventId(replyTo: MessageId | undefined): string | undefined;
export declare function matrixOutboundMessageContent(payload: OutboundPayload): MatrixEventContent;
export declare function createFetchMatrixSendClient(homeserverUrl: string, accessToken: string, options?: FetchMatrixSendClientOptions): MatrixSendClient;
export declare class MatrixCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    readonly accountId: AccountId;
    private readonly homeserverUrl;
    private readonly accessToken;
    private readonly userId;
    private readonly syncClient;
    private readonly sendClient;
    private readonly sleep;
    private readonly now;
    private readonly sentByKey;
    private allowedUserIds;
    private allowedRoomIds;
    private inboundHandler;
    private stateHandler;
    private filterDropHandler;
    private connectionState;
    private started;
    private rateLimited;
    constructor(options: MatrixCommAdapterOptions);
    get allowedSenderIds(): readonly string[];
    updateAllowedSenderIds(ids: readonly string[]): void;
    exclusiveResource(): {
        resourceId: string;
    } | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    onInbound(handler: (msg: Message) => Promise<void>): void;
    onConnectionState(handler: (state: CommConnectionState) => void): void;
    onFilterDrop(handler: (event: FilterDropEvent) => void): void;
    send(target: ChatRef, payload: OutboundPayload, idempotencyKey: string): Promise<SendResult>;
    reportPressure(): {
        backlog: number;
        rateLimited: boolean;
    };
    classifyFailure(error: unknown): FailureClassification;
    private processSyncResponse;
    private handleTimelineEvent;
    private emitState;
    private emitFilterDrop;
}
export declare function mxidLocalpart(userId: string): string | null;
export declare function isMatrixMxid(value: string): boolean;
export declare function probeMatrixIdentity(homeserverUrl: string, accessToken: string, expectedUserId: string, client?: MatrixIdentityClient): Promise<{
    user_id: string;
    localpart: string | null;
}>;
//# sourceMappingURL=adapter.d.ts.map