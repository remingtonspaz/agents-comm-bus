import TelegramBot from "node-telegram-bot-api";
import type { ChatRef, CommConnectionState, CommAdapter, FailureClassification, Message, OutboundPayload, SendResult, CommId } from "../../../../agents-comm-bus-core/dist/index.js";
export interface TelegramCommAdapterOptions {
    botToken: string;
    allowedUserIds?: readonly string[];
    polling?: boolean;
    bot?: TelegramBot;
    now?: () => number;
}
export declare class TelegramCommAdapter implements CommAdapter {
    private readonly options;
    readonly id: CommId;
    private readonly now;
    private readonly allowedUserIds;
    private readonly sentByKey;
    private inboundHandler;
    private stateHandler;
    private connectionState;
    private bot;
    private botUserId;
    constructor(options: TelegramCommAdapterOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    onInbound(handler: (msg: Message) => Promise<void>): void;
    onConnectionState(handler: (state: CommConnectionState) => void): void;
    send(target: ChatRef, payload: OutboundPayload, idempotencyKey: string): Promise<SendResult>;
    reportPressure(): {
        backlog: number;
        rateLimited: boolean;
    };
    classifyFailure(error: unknown): FailureClassification;
    private handleTelegramMessage;
    private requireBot;
    private emitState;
}
export declare function probeTelegramIdentity(botToken: string): Promise<{
    bot_user_id: string;
    bot_username?: string;
}>;
//# sourceMappingURL=telegram.d.ts.map