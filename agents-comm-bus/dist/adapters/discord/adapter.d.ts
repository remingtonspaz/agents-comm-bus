import { type RawFile } from "@discordjs/rest";
import type { AccountId, BlobStore, ChatRef, CommConnectionState, CommAdapter, FailureClassification, FilterDropEvent, Message, OutboundPayload, SendResult, CommId } from "agents-comm-bus-core";
import { type DiscordGatewayLike } from "./gateway.js";
/** Injectable REST surface for tests and production. */
export interface DiscordRestLike {
    post(route: `/${string}`, options: {
        body: Record<string, unknown>;
        files?: RawFile[];
    }): Promise<unknown>;
    get(route: `/${string}`): Promise<unknown>;
    setToken(token: string): this;
    destroy?(): void;
}
export interface DiscordCommAdapterOptions {
    botToken: string;
    applicationId?: string;
    accountId: AccountId;
    allowedUserIds?: readonly string[];
    rest?: DiscordRestLike;
    gateway?: DiscordGatewayLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * AGE-10: verbose allowlist-filter tracing. When true, every inbound
     * allowlist evaluation (pass AND drop) logs one line via `log`.
     */
    filterTrace?: boolean;
    log?: (message: string) => void;
    attachmentBlobStore?: BlobStore;
    fetch?: typeof fetch;
}
export declare class DiscordCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    readonly accountId: AccountId;
    private readonly now;
    private readonly sleep;
    private readonly filterTrace;
    private readonly log;
    private allowedUserIds;
    private readonly sentByKey;
    private inboundHandler;
    private filterDropHandler;
    private stateHandler;
    private connectionState;
    private rest;
    private restForGateway;
    private gateway;
    private botUserId;
    private rateLimited;
    private readonly fetchImpl;
    constructor(options: DiscordCommAdapterOptions);
    get allowedSenderIds(): readonly string[];
    updateAllowedSenderIds(ids: readonly string[]): void;
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
    private handleDiscordMessageCreate;
    private enrichAttachments;
    private retrieveAttachment;
    private rememberSent;
    private requireRest;
    private emitState;
    private emitFilterDrop;
    private traceFilterPass;
}
export declare function discordMessageBody(payload: OutboundPayload, idempotencyKey?: string): Record<string, unknown>;
/**
 * Discord upload names must not leak caller local paths to chat recipients.
 * win32.basename treats both \\ and / as separators, so IPC paths from either
 * platform basename correctly on any host.
 */
export declare function uploadFilenameFromLocalPath(localPath: string): string;
export declare function probeDiscordIdentity(botToken: string, rest?: DiscordRestLike): Promise<{
    bot_user_id: string;
    bot_username?: string;
}>;
//# sourceMappingURL=adapter.d.ts.map