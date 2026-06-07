import type { AccountId, ChatRef, CommAdapter, CommConnectionState, CommId, FailureClassification, FilterDropEvent, Message, OutboundPayload, SendResult } from "agents-comm-bus-core";
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
export declare class MatrixCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    readonly accountId: AccountId;
    private readonly homeserverUrl;
    private readonly accessToken;
    private readonly userId;
    private allowedUserIds;
    private inboundHandler;
    private stateHandler;
    private filterDropHandler;
    private connectionState;
    private started;
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
    send(_target: ChatRef, _payload: OutboundPayload, _idempotencyKey: string): Promise<SendResult>;
    reportPressure(): {
        backlog: number;
        rateLimited: boolean;
    };
    classifyFailure(error: unknown): FailureClassification;
    private emitState;
}
export declare function mxidLocalpart(userId: string): string | null;
export declare function isMatrixMxid(value: string): boolean;
export declare function probeMatrixIdentity(homeserverUrl: string, accessToken: string, expectedUserId: string, client?: MatrixIdentityClient): Promise<{
    user_id: string;
    localpart: string | null;
}>;
//# sourceMappingURL=adapter.d.ts.map