import type { AccountId, ChatRef, CommConnectionState, CommAdapter, FailureClassification, FilterDropEvent, Message, OutboundPayload, SendResult, CommId } from "agents-comm-bus-core";
/** Injectable REST surface for tests and production. */
export interface DiscordRestLike {
    post(route: `/${string}`, options: {
        body: Record<string, unknown>;
    }): Promise<unknown>;
    get(route: `/${string}`): Promise<unknown>;
    setToken(token: string): this;
    destroy?(): void;
}
export interface DiscordCommAdapterOptions {
    botToken: string;
    applicationId?: string;
    accountId: AccountId;
    /** Resolved allowlist ids (wired on inbound in a later phase). */
    allowedUserIds?: readonly string[];
    rest?: DiscordRestLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
export declare class DiscordCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    readonly accountId: AccountId;
    private readonly now;
    private readonly sleep;
    private readonly sentByKey;
    private inboundHandler;
    private filterDropHandler;
    private stateHandler;
    private connectionState;
    private rest;
    private rateLimited;
    constructor(options: DiscordCommAdapterOptions);
    exclusiveResource(): {
        resourceId: string;
    } | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    onInbound(handler: (msg: Message) => Promise<void>): void;
    onFilterDrop(handler: (event: FilterDropEvent) => void): void;
    onConnectionState(handler: (state: CommConnectionState) => void): void;
    send(target: ChatRef, payload: OutboundPayload, idempotencyKey: string): Promise<SendResult>;
    reportPressure(): {
        backlog: number;
        rateLimited: boolean;
    };
    classifyFailure(error: unknown): FailureClassification;
    private requireRest;
    private emitState;
}
export declare function discordMessageBody(payload: OutboundPayload): Record<string, unknown>;
export declare function probeDiscordIdentity(botToken: string, rest?: DiscordRestLike): Promise<{
    bot_user_id: string;
    bot_username?: string;
}>;
//# sourceMappingURL=adapter.d.ts.map