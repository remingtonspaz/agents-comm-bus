import TelegramBot from "node-telegram-bot-api";
import type { AccountId, CallbackEvent, ChatRef, CommConnectionState, CommAdapter, FailureClassification, Message, OutboundPayload, SendResult, CommId } from "../../../../../agents-comm-bus-core/dist/index.js";
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
}
export declare class TelegramCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    readonly accountId: AccountId;
    private readonly now;
    private readonly allowedUserIds;
    private readonly sentByKey;
    private inboundHandler;
    private readonly callbackHandlers;
    private stateHandler;
    private connectionState;
    private bot;
    private botUserId;
    constructor(options: TelegramCommAdapterOptions);
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
    private emitState;
}
export declare function probeTelegramIdentity(botToken: string): Promise<{
    bot_user_id: string;
    bot_username?: string;
}>;
//# sourceMappingURL=adapter.d.ts.map