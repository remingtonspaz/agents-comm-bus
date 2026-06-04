import TelegramBot from "node-telegram-bot-api";
import type { AccountId, BlobStore, CallbackEvent, ChatRef, CommConnectionState, CommAdapter, FailureClassification, FilterDropEvent, Message, OutboundPayload, SendResult, CommId } from "agents-comm-bus-core";
/**
 * If `error` is a Telegram getUpdates 409 Conflict (another live consumer is
 * polling the same bot token), return a LOUD, actionable message; else null.
 *
 * AGE-35: behind the cross-checkout comm-resource lease, a 409 means a
 * non-lease-aware poller (a stray daemon from an unmanaged process, or an
 * external bot instance) — it must be surfaced with the bot / account / resource,
 * not silently flapped to "degraded".
 */
export declare function pollingConflictMessage(error: unknown, accountId: string, botUserId: string | null): string | null;
export interface TelegramCommAdapterOptions {
    botToken: string;
    /**
     * Telegram `bot_user_id` this adapter is bound to. Used by `MessageBus`
     * to key its adapter map so multiple bots can share `comm.id="telegram"`.
     */
    accountId: AccountId;
    allowedUserIds?: readonly string[];
    polling?: boolean;
    bot?: TelegramBot;
    now?: () => number;
    attachmentBlobStore?: BlobStore;
    fetch?: typeof fetch;
    /**
     * Loud logger for actionable anomalies (e.g. a 409 polling conflict). Defaults
     * to console.error (→ the daemon's stderr). Injectable for tests.
     */
    log?: (message: string) => void;
    /**
     * AGE-10: verbose allowlist-filter tracing. When true, every inbound
     * allowlist evaluation (pass AND drop) logs one line via `log` — the
     * debug mode for "message sent but nothing happened at all" sessions.
     * Defaults to `process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1"`.
     */
    filterTrace?: boolean;
}
export declare class TelegramCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    readonly accountId: AccountId;
    private readonly now;
    private allowedUserIds;
    private readonly sentByKey;
    private inboundHandler;
    private readonly callbackHandlers;
    private filterDropHandler;
    private readonly filterTrace;
    private stateHandler;
    private connectionState;
    private bot;
    private botUserId;
    private readonly fetchImpl;
    private readonly log;
    constructor(options: TelegramCommAdapterOptions);
    /**
     * Derived view of the allowlist. Returns a snapshot array each access so
     * callers (notably the bus's foreign-bot gate) always see the current Set
     * state. The backing Set is replaceable via {@link updateAllowedSenderIds}.
     */
    get allowedSenderIds(): readonly string[];
    /**
     * Replace the in-memory allowlist with a new set of ids. Called by the
     * daemon's reload path when DB-backed allowlist rows change for an
     * already-attached adapter — avoids tearing down + recreating the adapter
     * and its live polling connection.
     *
     * Concurrency note: the daemon (and Node's event loop) is single-threaded
     * today, so there's no torn-read concern — an inbound handler dispatch
     * that started before this assignment continues to read the OLD Set; the
     * next dispatch reads the NEW Set. If reload-during-receiveInbound ever
     * becomes truly concurrent (e.g. via worker threads), the contract
     * should become "atomic snapshot replace" rather than mid-flight mutation.
     */
    updateAllowedSenderIds(ids: readonly string[]): void;
    /**
     * Telegram's `getUpdates` long-poll allows exactly one live consumer per bot
     * token — a second poller gets `409 Conflict: terminated by other getUpdates`.
     * The exclusive resource is therefore the bot_user_id (this adapter's
     * accountId): the daemon takes a cross-checkout ownership lease keyed by
     * (id, resourceId) before starting this adapter, so a stray daemon from
     * another checkout never races us to a 409.
     */
    exclusiveResource(): {
        resourceId: string;
    } | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    onInbound(handler: (msg: Message) => Promise<void>): void;
    onCallback(handler: (event: CallbackEvent) => Promise<void>): void;
    /**
     * AGE-10: subscribe to adapter-level inbound filter drops. Wired by the bus
     * in `registerComm`; one event per dropped update.
     */
    onFilterDrop(handler: (event: FilterDropEvent) => void): void;
    answerCallback(callbackId: string, options?: {
        text?: string;
        showAlert?: boolean;
    }): Promise<void>;
    editMessage(chatNativeId: string, messageNativeId: string, text: string, options?: {
        format?: "html" | "plain";
    }): Promise<void>;
    onConnectionState(handler: (state: CommConnectionState) => void): void;
    send(target: ChatRef, payload: OutboundPayload, idempotencyKey: string): Promise<SendResult>;
    reportPressure(): {
        backlog: number;
        rateLimited: boolean;
    };
    classifyFailure(error: unknown): FailureClassification;
    private handleTelegramCallback;
    private handleTelegramMessage;
    private requireBot;
    private normalizeAttachments;
    private retrieveAttachment;
    private emitState;
    /**
     * AGE-10: surface an adapter-level inbound drop instead of silently
     * returning. The handler (wired by the bus in `registerComm`) audits it as
     * `inbound_filter_drop`; with `filterTrace` enabled the drop also logs a
     * one-line trace via `log` for live debugging.
     */
    private emitFilterDrop;
    /** AGE-10: with `filterTrace` enabled, log allowlist passes too — proof the filter is letting traffic through. */
    private traceFilterPass;
}
export declare function probeTelegramIdentity(botToken: string): Promise<{
    bot_user_id: string;
    bot_username?: string;
}>;
//# sourceMappingURL=adapter.d.ts.map