import type { AccountId, ChatRef, CommAdapter, CommConnectionState, CommId, FailureClassification, FilterDropEvent, InboundAcceptance, Message, OutboundPayload, SendResult, Storage } from "agents-comm-bus-core";
export { syntheticChatNativeId } from "./idempotency.js";
export declare const CURL_LOOPBACK_HOST = "127.0.0.1";
export declare const CURL_MESSAGES_PATH = "/messages";
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
export declare function sanitizeAccountIdForPath(accountId: string): string;
export declare function curlEndpointFilePath(stateRoot: string, accountId: string): string;
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
export declare function parseCurlPostBody(raw: unknown): {
    body: ParsedCurlPost;
} | {
    error: string;
};
/** Constant-time bearer-token check over the `Authorization` header. */
export declare function isAuthorizedCurlRequest(authorizationHeader: string | undefined, token: string): boolean;
export declare class CurlCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    readonly accountId: AccountId;
    private readonly now;
    private readonly log;
    private readonly filterTrace;
    private readonly maxBodyBytes;
    private readonly normalizedProject;
    private allowedSenders;
    private inboundHandler;
    private filterDropHandler;
    private stateHandler;
    private connectionState;
    private server;
    private boundPort;
    private readonly inflightByScope;
    constructor(options: CurlCommAdapterOptions);
    get allowedSenderIds(): readonly string[];
    updateAllowedSenderIds(ids: readonly string[]): void;
    /** Bound loopback port once started (ephemeral binds resolve here). */
    get port(): number | null;
    /**
     * One live HTTP listener per registration: a second daemon serving the same
     * curl account would race for the port (or silently split discovery files),
     * so the account id is the exclusive single-consumer resource.
     */
    exclusiveResource(): {
        resourceId: string;
    } | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    onInbound(handler: (msg: Message) => Promise<void | InboundAcceptance>): void;
    onFilterDrop(handler: (event: FilterDropEvent) => void): void;
    onConnectionState(handler: (state: CommConnectionState) => void): void;
    /**
     * V1 is inbound-only by spec: there is no caller to deliver outbound to —
     * the HTTP exchange is over by the time an agent replies. Loud diagnostic
     * instead of a silent no-op so a misrouted `bus.send` is debuggable.
     */
    send(target: ChatRef, _payload: OutboundPayload, _idempotencyKey: string): Promise<SendResult>;
    reportPressure(): {
        backlog: number;
        rateLimited: boolean;
    };
    classifyFailure(): FailureClassification;
    private handleRequest;
    private handleIdempotentPost;
    private processIdempotentPost;
    private dispatchInbound;
    private respondAccepted;
    private readBody;
    private respondJson;
    private writeEndpointFile;
    private removeEndpointFile;
    private emitState;
    private emitFilterDrop;
    private traceFilterPass;
}
//# sourceMappingURL=adapter.d.ts.map