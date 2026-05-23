import TelegramBot from "node-telegram-bot-api";
import type { AccountId, BlobStore, CallbackEvent, ChatRef, CommConnectionState, CommAdapter, FailureClassification, Message, OutboundPayload, SendResult, CommId } from "../../../../../agents-comm-bus-core/dist/index.js";
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
    private stateHandler;
    private connectionState;
    private bot;
    private botUserId;
    private readonly fetchImpl;
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
    start(): Promise<void>;
    stop(): Promise<void>;
    onInbound(handler: (msg: Message) => Promise<void>): void;
    onCallback(handler: (event: CallbackEvent) => Promise<void>): void;
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
}
export declare function probeTelegramIdentity(botToken: string): Promise<{
    bot_user_id: string;
    bot_username?: string;
}>;
//# sourceMappingURL=adapter.d.ts.map